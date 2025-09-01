/**
 * index.js
 * Entry point for the Gemini Live (Speech-to-Speech) streaming application.
 * This server handles real-time audio streaming between AVR Core and Gemini Live,
 * performing necessary audio format conversions and WebSocket communication.
 */

const express = require("express");
const WebSocket = require("ws");
require("dotenv").config();

const INTERVAL_MS = parseInt(process.env.INTERVAL_MS) || 20;

// Initialize Express application
const app = express();

/**
 * Audio Processing Utilities
 */

/**
 * Upsamples audio from 8kHz 16-bit mono to 16kHz 16-bit mono using linear interpolation.
 * @param {Buffer} audioBuffer - Input audio buffer (8kHz, 16-bit, mono)
 * @returns {Buffer} Upsampled audio buffer (16kHz, 16-bit, mono)
 */
const upsample8kTo16k = (audioBuffer) => {
  if (!audioBuffer || audioBuffer.length === 0) {
    return Buffer.alloc(0);
  }

  // 16kHz / 8kHz = 2x upsampling factor
  const upsamplingFactor = 2;
  const bytesPerSample = 2;
  const inputSampleCount = audioBuffer.length / bytesPerSample;

  if (inputSampleCount < 2) {
    return audioBuffer;
  }

  const outputSampleCount = inputSampleCount * upsamplingFactor;
  const outputBuffer = Buffer.alloc(outputSampleCount * bytesPerSample);

  for (let i = 0; i < inputSampleCount - 1; i++) {
    const currentSample = audioBuffer.readInt16LE(i * bytesPerSample);
    const nextSample = audioBuffer.readInt16LE((i + 1) * bytesPerSample);

    // Two samples between current and next: j = 0,1
    for (let j = 0; j < upsamplingFactor; j++) {
      const interpolationFactor = j / upsamplingFactor;
      const interpolatedSample = Math.round(
        currentSample + (nextSample - currentSample) * interpolationFactor
      );
      const clampedSample = Math.max(-32768, Math.min(32767, interpolatedSample));
      const outputIndex = (i * upsamplingFactor + j) * bytesPerSample;
      outputBuffer.writeInt16LE(clampedSample, outputIndex);
    }
  }

  // Repeat last sample
  const lastSample = audioBuffer.readInt16LE((inputSampleCount - 1) * bytesPerSample);
  for (let j = 0; j < upsamplingFactor; j++) {
    const outputIndex = ((inputSampleCount - 1) * upsamplingFactor + j) * bytesPerSample;
    outputBuffer.writeInt16LE(lastSample, outputIndex);
  }

  return outputBuffer;
};

/**
 * Downsamples audio from 24kHz 16-bit mono to 8kHz 16-bit mono via decimation by 3.
 * @param {Buffer} audioBuffer - Input audio buffer (24kHz, 16-bit, mono)
 * @returns {Buffer} Downsampled audio buffer (8kHz, 16-bit, mono)
 */
const downsample24kTo8k = (audioBuffer) => {
  if (!audioBuffer || audioBuffer.length === 0) {
    return Buffer.alloc(0);
  }

  const downsamplingFactor = 3;
  const bytesPerSample = 2;
  const inputSampleCount = audioBuffer.length / bytesPerSample;

  if (inputSampleCount < downsamplingFactor) {
    return audioBuffer;
  }

  const outputSampleCount = Math.floor(inputSampleCount / downsamplingFactor);
  const outputBuffer = Buffer.alloc(outputSampleCount * bytesPerSample);

  for (let i = 0; i < outputSampleCount; i++) {
    const inputIndex = i * downsamplingFactor;
    const sample = audioBuffer.readInt16LE(inputIndex * bytesPerSample);
    outputBuffer.writeInt16LE(sample, i * bytesPerSample);
  }

  return outputBuffer;
};

/**
 * Creates and configures a WebSocket connection to Gemini Live API.
 * The Live API expects raw PCM16 input (commonly 16kHz) and outputs audio at 24kHz.
 * URL and headers are controlled via environment variables to allow flexibility.
 *
 * @returns {WebSocket} Configured WebSocket instance
 */
/**
 * Establish a Gemini Live session using the official @google/genai SDK.
 * Falls back to manual WS only if GEMINI_WS_URL is explicitly provided.
 */
function resolveLiveModel(raw) {
  const val = (raw || "").trim();
  if (!val) return "models/gemini-live-2.5-flash-preview";
  const lower = val.toLowerCase();
  // Map common invalid/legacy names to supported Live models
  if (lower.includes("flash-live")) return "models/gemini-live-2.5-flash-preview";
  if (lower.includes("native-audio")) return "models/gemini-2.5-flash-preview-native-audio-dialog";
  // If caller provided bare name, prefix models/
  return lower.startsWith("models/") ? val : `models/${val}`;
}

const connectToGeminiSdk = async (callbacks) => {
  const genai = await import("@google/genai");
  const { GoogleGenAI, Modality } = genai;
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  const model = resolveLiveModel(process.env.GEMINI_MODEL);
  console.log(`Using Gemini Live model: ${model}`);

  const config = {
    responseModalities: [Modality.AUDIO],
    systemInstruction:
      process.env.GEMINI_INSTRUCTIONS ||
      "You are a helpful assistant and answer in a friendly tone.",
  };

  const session = await client.live.connect({
    model,
    callbacks,
    config,
  });

  return session;
};

/**
 * Handles incoming client audio stream and manages communication with Gemini Live API.
 * Buffers audio chunks and sends fixed-size frames upstream; buffers downlink audio and
 * writes fixed-size frames downstream to the HTTP response.
 */
const handleAudioStream = async (req, res) => {
  console.log("New audio stream received (Gemini)");

  const explicitWsUrl = process.env.GEMINI_WS_URL;
  let session = null;
  let ws = null;
  // Using server-managed turn coverage; no manual commit logic

  const sdkCallbacks = {
    onopen: () => {
      console.log("Gemini SDK session opened");
    },
    onmessage: (message) => {
      try {
        const parts = message?.serverContent?.modelTurn?.parts || [];
        for (const part of parts) {
          if (part?.inlineData?.data) {
            const mime = part.inlineData?.mimeType || "audio/pcm;rate=24000";
            let decoded = Buffer.from(part.inlineData.data, "base64");
            if (mime.startsWith("audio/wav") && decoded.length > 44) {
              decoded = decoded.slice(44);
            }
            const resampled = downsample24kTo8k(decoded);
            outputAudioBuffer = Buffer.concat([outputAudioBuffer, resampled]);
          }
        }

        // Also handle direct data frames
        if (message?.data) {
          let buf;
          if (Buffer.isBuffer(message.data)) {
            buf = message.data;
          } else if (typeof message.data === "string") {
            buf = Buffer.from(message.data, "base64");
          }
          if (buf && buf.length > 0) {
            const resampled = downsample24kTo8k(buf);
            outputAudioBuffer = Buffer.concat([outputAudioBuffer, resampled]);
          }
        }
      } catch (err) {
        console.error("SDK onmessage error:", err.message || err);
      }
    },
    onerror: (e) => console.error("Gemini SDK session error:", e.message || e),
    onclose: (e) => console.log("Gemini SDK session closed", e?.code || "", e?.reason || ""),
  };

  try {
    if (explicitWsUrl) {
      // Only use raw WS when explicitly requested
      const apiKey = process.env.GEMINI_API_KEY || "";
      const urlWithKey = explicitWsUrl.includes("?") ? `${explicitWsUrl}&key=${encodeURIComponent(apiKey)}` : `${explicitWsUrl}?key=${encodeURIComponent(apiKey)}`;
      console.log(`Connecting to Gemini Live WS (explicit): ${urlWithKey}`);
      ws = new WebSocket(urlWithKey);
    } else {
      session = await connectToGeminiSdk(sdkCallbacks);
      console.log("Gemini Live session established via SDK");
      // Send brief silence to keep session open until audio arrives
      try {
        const silenceBase64 = Buffer.alloc(3200, 0).toString("base64");
        await session.sendRealtimeInput({
          media: [
            { data: silenceBase64, mimeType: "audio/pcm;rate=16000" },
          ],
        });
      } catch (e) {
        console.error("Error sending initial silence:", e.message);
      }
    }
  } catch (e) {
    console.error("Failed to establish Gemini session:", e.message);
    res.status(502).end();
    return;
  }

  let inputAudioBuffer = Buffer.alloc(0);
  let outputAudioBuffer = Buffer.alloc(0);
  let buffer = Buffer.alloc(0);

  // At 16kHz, 100ms = 1600 samples = 3200 bytes
  const INPUT_CHUNK_BYTES_16K_100MS = 3200;

  const inputAudioBufferInterval = setInterval(async () => {
    if (inputAudioBuffer.length >= INPUT_CHUNK_BYTES_16K_100MS) {
      const chunk = inputAudioBuffer.slice(0, INPUT_CHUNK_BYTES_16K_100MS);
      inputAudioBuffer = inputAudioBuffer.slice(INPUT_CHUNK_BYTES_16K_100MS);

      try {
        if (session) {
          await session.sendRealtimeInput({
            media: [
              { data: chunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
            ],
          });
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          // Fallback raw message (won't work unless GEMINI_WS_URL speaks a JSON envelope)
          ws.send(JSON.stringify({ type: "input_audio", mimeType: "audio/pcm;rate=16000", data: chunk.toString("base64") }));
        }
      } catch (e) {
        console.error("Error sending audio to Gemini:", e.message);
      }
    }
  }, 100);

  const outputAudioBufferInterval = setInterval(() => {
    if (outputAudioBuffer.length >= 320) {
      const chunk = outputAudioBuffer.slice(0, 320);
      res.write(chunk);
      outputAudioBuffer = outputAudioBuffer.slice(320);
    }
  }, INTERVAL_MS);

  if (ws) {
    ws.on("open", () => {
      console.log("WebSocket connected to Gemini Live (explicit URL)");
    });
  }

  if (ws) {
    ws.on("message", (data) => {
      // Unknown protocol; keep for explicit custom endpoints only
      try {
        const message = JSON.parse(data);
        const base64 = message?.delta || message?.audio || message?.inlineData?.data;
        if (base64) {
          const decoded = Buffer.from(base64, "base64");
          const resampled = downsample24kTo8k(decoded);
          outputAudioBuffer = Buffer.concat([outputAudioBuffer, resampled]);
        }
      } catch (error) {
        console.error("Error processing explicit WS message:", error.message);
      }
    });
  }

  // SDK callbacks were provided at connect time

  if (ws) {
    ws.on("close", () => {
      console.log("WebSocket connection closed (Gemini)");
      clearInterval(inputAudioBufferInterval);
      clearInterval(outputAudioBufferInterval);
      res.end();
    });

    ws.on("error", (err) => {
      console.error("WebSocket error (Gemini):", err);
      clearInterval(inputAudioBufferInterval);
      clearInterval(outputAudioBufferInterval);
      res.end();
    });
  }

  // No manual turn completion; rely on server turn coverage

  // Handle incoming audio data from AVR Core (8kHz PCM16)
  req.on("data", (chunk) => {
    const resampled = upsample8kTo16k(chunk);
    inputAudioBuffer = Buffer.concat([inputAudioBuffer, resampled]);
  });

  req.on("end", () => {
    console.log("Request stream ended (Gemini)");
    try { session && session.close && session.close(); } catch (_) {}
    try { ws && ws.close && ws.close(); } catch (_) {}
    // no-op
  });

  req.on("error", (err) => {
    console.error("Request error (Gemini):", err);
    try { session && session.close && session.close(); } catch (_) {}
    try { ws && ws.close && ws.close(); } catch (_) {}
    // no-op
  });
};

// API Endpoints
app.post("/speech-to-speech-stream", handleAudioStream);

// Start server
const PORT = process.env.PORT || 6032;
app.listen(PORT, () => {
  console.log(`Gemini Speech-to-Speech server running on port ${PORT}`);
});


