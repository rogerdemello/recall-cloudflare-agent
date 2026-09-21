/**
 * Push-to-talk.
 *
 * Records a clip with MediaRecorder, posts the raw bytes to `/api/transcribe`,
 * and hands back the text. The Worker runs it through Whisper on Workers AI and
 * the transcript is then sent as an ordinary chat message — so voice and typing
 * converge on exactly the same code path in the agent.
 *
 * The audio never goes over the agent's WebSocket. A few hundred kilobytes of
 * Opus has no business travelling on the channel carrying token deltas.
 */

export interface VoiceCallbacks {
  onStateChange(recording: boolean): void;
  onTranscript(text: string): void;
  onError(message: string): void;
}

/** Guard against a clip long enough to get rejected by the Worker. */
const MAX_SECONDS = 60;

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: BlobPart[] = [];
  private timeout: number | null = null;

  constructor(private readonly callbacks: VoiceCallbacks) {}

  /** Whether this browser can record at all. Safari needs a secure context. */
  static isSupported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== "undefined"
    );
  }

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  async toggle(): Promise<void> {
    if (this.isRecording) {
      this.stop();
    } else {
      await this.start();
    }
  }

  private async start(): Promise<void> {
    if (!VoiceRecorder.isSupported()) {
      this.callbacks.onError("This browser can't record audio.");
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Almost always a denied permission prompt.
      this.callbacks.onError("Microphone access was blocked.");
      return;
    }

    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, pickMimeType());

    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    this.recorder.addEventListener("stop", () => {
      void this.finish();
    });

    this.recorder.start();
    this.callbacks.onStateChange(true);

    this.timeout = window.setTimeout(() => this.stop(), MAX_SECONDS * 1000);
  }

  private stop(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.recorder?.state === "recording") {
      this.recorder.stop();
    }
    this.callbacks.onStateChange(false);
  }

  private async finish(): Promise<void> {
    // Release the mic promptly — the browser shows a recording indicator for as
    // long as any track stays live, which is alarming if we leave it open.
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    const type = this.recorder?.mimeType || "audio/webm";
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    this.recorder = null;

    // Anything this short is a mis-click, not speech.
    if (blob.size < 2_000) {
      this.callbacks.onError("That was too short to hear.");
      return;
    }

    try {
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": type },
        body: blob,
      });

      const payload = (await response.json()) as {
        text?: string;
        error?: string;
      };

      if (!response.ok || !payload.text) {
        this.callbacks.onError(payload.error ?? "Couldn't transcribe that.");
        return;
      }

      this.callbacks.onTranscript(payload.text);
    } catch {
      this.callbacks.onError("Transcription request failed.");
    }
  }
}

/**
 * Pick a container the browser will actually produce.
 *
 * Chrome and Firefox give webm/opus; Safari only does mp4. Passing an
 * unsupported type to the MediaRecorder constructor throws, so probe first and
 * fall back to the browser default rather than guessing.
 */
function pickMimeType(): MediaRecorderOptions {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType };
  }
  return {};
}
