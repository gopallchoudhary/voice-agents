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

		console.log(`Received user query: "${userText}"`);

		const response = await client.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [{ role: "user", content: userText }],
		});

		const outputText = response.choices[0]?.message?.content ?? "";
		console.log(`LLM Reply: "${outputText}"`);

		res.json({ reply: outputText });
	} catch (error) {
		console.error("OpenAI API error:", error);
		res.status(500).json({ error: error.message });
	}
});

app.listen(PORT, () => {
	console.log(`🚀 Backend server running at http://localhost:${PORT}`);
});
