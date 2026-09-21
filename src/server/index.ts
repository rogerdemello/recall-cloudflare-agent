/**
 * Worker entry point.
 *
 * Almost everything lives in the agent; this file only has to do two things:
 * hand WebSocket and HTTP traffic to the right Durable Object instance, and
 * transcribe audio for the push-to-talk button.
 *
 * Transcription is a plain Worker route rather than an agent method because
 * audio is bulk binary — pushing several hundred kilobytes through the agent's
 * WebSocket to get a sentence of text back would be a poor trade. The browser
 * posts the clip here, gets a transcript, and sends that down the socket as an
 * ordinary chat message.
 */

import { routeAgentRequest } from "agents";
import { transcribe } from "ai";
import { transcriptionModel } from "./model";

// Both classes must be exported from the Worker's entry module for the runtime
// to bind them — the Durable Object namespace and the Workflow binding in
// wrangler.jsonc resolve against these names.
export { StudyCoach } from "./agent";
export { DeckBuilder } from "./deck-workflow";

/** Generous for a voice note, small enough to reject obvious abuse. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/transcribe") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return transcribeAudio(request, env);
    }

    // Routes /agents/:agent/:instance — both the WebSocket upgrade and any
    // plain HTTP calls — to the matching Durable Object.
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function transcribeAudio(request: Request, env: Env): Promise<Response> {
  let audio: ArrayBuffer;
  try {
    audio = await request.arrayBuffer();
  } catch {
    return Response.json({ error: "Could not read the audio." }, { status: 400 });
  }

  if (audio.byteLength === 0) {
    return Response.json({ error: "No audio received." }, { status: 400 });
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return Response.json({ error: "That clip is too long." }, { status: 413 });
  }

  try {
    const result = await transcribe({
      model: transcriptionModel(env),
      audio: new Uint8Array(audio),
    });

    const text = result.text.trim();
    if (!text) {
      return Response.json({ error: "I didn't catch anything." }, { status: 422 });
    }
    return Response.json({ text });
  } catch (error) {
    console.error("transcription failed", error);
    return Response.json(
      { error: "Could not transcribe that. Try typing instead." },
      { status: 500 },
    );
  }
}
