# Agent Voice Response - Gemini Live Speech-to-Speech Integration

This service bridges AVR Core with Google Gemini 2.5 Flash Live via WebSocket, handling audio resampling so AVR can stream 8 kHz PCM16 while Gemini ingests 16 kHz and outputs 24 kHz.

## Environment Variables

Required:

- `GEMINI_API_KEY`: Google API key with access to Gemini Live

Optional:

- `PORT` (default: 6032)
- `GEMINI_MODEL` (default: `gemini-2.5-flash-live`)
- `GEMINI_WS_URL` (override full WS URL if needed)
- `GEMINI_USE_HEADER_KEY` ("true" to send key in `x-goog-api-key` header)
- `GEMINI_INSTRUCTIONS` (system prompt)
- `GEMINI_TEMPERATURE` (default: 0.8)
- `GEMINI_MAX_TOKENS` (default: "inf")

## API Endpoint

- `POST /speech-to-speech-stream`
  - Request: raw 16-bit PCM mono at 8 kHz
  - Response: streamed raw 16-bit PCM mono at 8 kHz

## Notes

- Input chunks are upsampled to 16 kHz for Gemini; output from Gemini is expected at 24 kHz and downsampled to 8 kHz for AVR.
- The message envelope currently mirrors OpenAI Realtime for compatibility; adjust `connectToGemini` and message handling to match the latest Gemini Live schema if different.


