const API_URL =
	window.location.port === "5000"
		? "/api/chat"
		: "http://localhost:5000/api/chat";

const statusEl = document.getElementById("status");
const toggleBtn = document.getElementById("toggle-btn");
const logEl = document.getElementById("log");

let speechRecognition = null;
let isListening = false;
let isSpeaking = false;

function updateStatus(text) {
	if (statusEl) statusEl.textContent = text;
	console.log(`[Status] ${text}`);
}

function appendMessage(role, text) {
	if (!logEl) return;
	const div = document.createElement("div");
	div.className = `msg ${role}`;
	div.textContent = `${role === "user" ? "You: " : "AI: "}${text}`;
	logEl.appendChild(div);
	div.scrollIntoView({ behavior: "smooth" });
}

// Play TTS Audio and prevent mic feedback
function speak(audioUrl) {
	return new Promise((resolve) => {
		if (!audioUrl) {
			resolve();
			return;
		}

		isSpeaking = true;
		updateStatus("🔊 Speaking...");

		// Stop microphone so the AI does not hear itself
		try {
			speechRecognition.stop();
		} catch (_) {}

		const audio = new Audio(audioUrl);

		const finishSpeaking = () => {
			isSpeaking = false;
			// Resume listening if agent is still turned on
			if (isListening) {
				updateStatus("🎤 Listening...");
				try {
					speechRecognition.start();
				} catch (_) {}
			}
			resolve();
		};

		audio.onended = finishSpeaking;
		audio.onerror = (err) => {
			console.error("Audio playback error:", err);
			finishSpeaking();
		};

		audio.play().catch((err) => {
			console.error("Autoplay prevented:", err);
			finishSpeaking();
		});
	});
}

// Send transcript to backend and receive text + audio
async function llm(userText) {
	try {
		updateStatus("🤔 Thinking...");
		const response = await fetch(API_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userText }),
		});

		if (!response.ok) {
			const err = await response.json();
			throw new Error(err.error || `HTTP ${response.status}`);
		}

		return await response.json();
	} catch (error) {
		console.error("LLM Error:", error);
		return { reply: `Error: ${error.message}`, audio: null };
	}
}

function initSpeechRecognition() {
	const SpeechRecognition =
		window.SpeechRecognition || window.webkitSpeechRecognition;

	if (!SpeechRecognition) {
		updateStatus("❌ SpeechRecognition not supported in this browser.");
		return null;
	}

	const sr = new SpeechRecognition();
	sr.continuous = true;
	sr.interimResults = false;
	sr.maxAlternatives = 1;
	sr.lang = "en-US";

	sr.onstart = function () {
		if (!isSpeaking) {
			updateStatus("🎤 Listening...");
		}
	};

	sr.onerror = function (event) {
		console.warn("Speech recognition error:", event.error);
		if (event.error === "no-speech") {
			return; // ignore silence timeouts
		}
		if (event.error === "network") {
			updateStatus("❌ Network error: Check internet/mic or run on localhost.");
		}
	};

	sr.onend = function () {
		// Restart listening if we didn't stop intentionally to speak
		if (isListening && !isSpeaking) {
			try {
				sr.start();
			} catch (_) {}
		}
	};

	sr.onresult = async function (event) {
		const transcript = event.results[event.results.length - 1][0].transcript.trim();
		if (!transcript) return;

		console.log("User:", transcript);
		appendMessage("user", transcript);

		const data = await llm(transcript);
		console.log("AI:", data.reply);
		appendMessage("ai", data.reply);

		if (data.audio) {
			await speak(data.audio);
		} else {
			// If no audio returned, resume listening
			if (isListening) {
				updateStatus("🎤 Listening...");
				try {
					sr.start();
				} catch (_) {}
			}
		}
	};

	return sr;
}

function setup() {
	speechRecognition = initSpeechRecognition();

	if (toggleBtn) {
		toggleBtn.addEventListener("click", () => {
			if (!speechRecognition) return;

			if (!isListening) {
				isListening = true;
				toggleBtn.textContent = "Stop Agent";
				toggleBtn.classList.add("listening");
				updateStatus("🎤 Starting microphone...");
				try {
					speechRecognition.start();
				} catch (_) {}
			} else {
				isListening = false;
				toggleBtn.textContent = "Start Listening";
				toggleBtn.classList.remove("listening");
				updateStatus("Stopped. Click to start again.");
				try {
					speechRecognition.stop();
				} catch (_) {}
			}
		});
	}
}

setup();
