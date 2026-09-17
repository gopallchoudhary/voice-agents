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

app.listen(PORT, () => {
	console.log(`🚀 Backend server running at http://localhost:${PORT}`);
});

// Keep process alive when launched as background process
process.stdin.resume();
