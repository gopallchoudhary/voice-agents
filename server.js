import "dotenv/config";
import express from "express";
import cors from "cors";
import { OpenAI } from "openai";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static("."));

const client = new OpenAI({
	apiKey: process.env.OPENROUTER_API_KEY,
	baseURL: process.env.OPENROUTER_BASE_URL,
});

app.post("/api/chat", async (req, res) => {
	try {
		const { userText } = req.body;
		if (!userText) {
			return res.status(400).json({ error: "userText is required" });
		}

		console.log(`\n📥 Received user query: "${userText}"`);

		// 1. Generate text response from LLM
		const completion = await client.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "system",
					content:
						"You are a helpful voice assistant. Keep answers clear, natural, and conversational (1-3 sentences max).",
				},
				{ role: "user", content: userText },
			],
		});

		const outputText = completion.choices[0]?.message?.content ?? "";
		console.log(`🤖 LLM Reply: "${outputText}"`);

		// 2. Generate spoken audio using Kokoro TTS
		let audioDataUrl = null;
		try {
			console.log("🔊 Generating TTS audio...");
			const speechResponse = await client.audio.speech.create({
				model: "hexgrad/kokoro-82m",
				voice: "af_alloy",
				input: outputText,
				response_format: "mp3",
			});

			const arrayBuffer = await speechResponse.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			const base64Audio = buffer.toString("base64");
			audioDataUrl = `data:audio/mp3;base64,${base64Audio}`;
			console.log(`✅ Audio generated (${buffer.length} bytes)`);
		} catch (ttsError) {
			console.error("⚠️ TTS generation failed:", ttsError.message);
		}

		// 3. Return both text and audio
		res.json({
			reply: outputText,
			audio: audioDataUrl,
		});
	} catch (error) {
		console.error("❌ Server error:", error);
		res.status(500).json({ error: error.message });
	}
});

app.post("/api/chat-stream", async (req, res) => {
	try {
		const { userText } = req.body;
		if (!userText) {
			return res.status(400).json({ error: "userText is required" });
		}

		console.log(`\n📥 [stream] Received user query: "${userText}"`);

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		// Comment line keeps some proxies/flush paths alive; ignored by parsers.
		res.write(": connected\n\n");

		let aborted = false;
		req.on("close", () => {
			aborted = true;
		});

		const send = (event, data) => {
			if (aborted) return;
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};

		// 1. Stream LLM text deltas (Chat Completions `delta.content` chunks
		// re-emitted as SSE `delta` events).
		let fullText = "";
		try {
			const stream = await client.chat.completions.create({
				model: "gpt-4o-mini",
				messages: [
					{
						role: "system",
						content:
							"You are a helpful voice assistant. Keep answers clear, natural, and conversational (1-3 sentences max).",
					},
					{ role: "user", content: userText },
				],
				stream: true,
			});

			for await (const chunk of stream) {
				if (aborted) break;
				const delta = chunk.choices?.[0]?.delta?.content || "";
				if (delta) {
					fullText += delta;
					send("delta", { text: delta });
				}
			}
		} catch (streamError) {
			console.error("⚠️ [stream] LLM stream failed:", streamError.message);
			send("error", { error: streamError.message });
			return res.end();
		}

		if (aborted) return res.end();
		console.log(`🤖 [stream] LLM Reply: "${fullText}"`);
		send("done", { reply: fullText });

		// 2. One-shot TTS after the full text is known (unchanged voice).
		let audioDataUrl = null;
		try {
			console.log("🔊 [stream] Generating TTS audio...");
			const speechResponse = await client.audio.speech.create({
				model: "hexgrad/kokoro-82m",
				voice: "af_alloy",
				input: fullText,
				response_format: "mp3",
			});

			const arrayBuffer = await speechResponse.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			audioDataUrl = `data:audio/mp3;base64,${buffer.toString("base64")}`;
			console.log(`✅ [stream] Audio generated (${buffer.length} bytes)`);
		} catch (ttsError) {
			console.error("⚠️ [stream] TTS generation failed:", ttsError.message);
		}

		if (aborted) return res.end();
		send("audio", { audio: audioDataUrl, reply: fullText });
		send("end", {});
		return res.end();
	} catch (error) {
		console.error("❌ [stream] Server error:", error);
		try {
			if (!res.headersSent) {
				return res.status(500).json({ error: error.message });
			}
			res.write(
				`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`,
			);
			return res.end();
		} catch (_) {}
	}
});

app.listen(PORT, () => {
	console.log(`🚀 Backend server running at http://localhost:${PORT}`);
});

// Keep process alive when launched as background process
process.stdin.resume();
