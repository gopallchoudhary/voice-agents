const API_URL =
	window.location.port === "5000"
		? "/api/chat"
		: "http://localhost:5000/api/chat";

const statusEl = document.getElementById("status");
const toggleBtn = document.getElementById("toggle-btn");
const logEl = document.getElementById("log");

let speechRecognition = null;
let isListening = false;
// UI-only flag: true while TTS audio element is playing. Unlike before,
// it no longer gates the microphone — mic stays open for barge-in.
let isSpeaking = false;

// Monotonic epoch. Bumped on every user final + every detected barge-in.
// In-flight fetch/speak carrying an older epoch is treated as stale and
// its audio is dropped ("finish but don't play").
let requestEpoch = 0;

// ---- Tunables for natural (hands-free) barge-in ----
const INTERRUPT_GRACE_MS = 700; // ignore interim right after audio starts (echo spike)
const INTERRUPT_MIN_CHARS = 4; // ignore tiny blips
const INTERRUPT_MIN_CONFIDENCE = 0.6; // ignore low-confidence echo (when provided)
const INTERRUPT_REQUIRED_CONSECUTIVE = 2; // require sustained speech, not one frame
const INTERRUPT_RESUME_DELAY_MS = 2500; // no final follows a cut -> resume TTS (false trigger)

const state = {
	currentlyPlaying: false,
	// { audio, audioUrl, startTime, epoch, replyText, finished, resolve } | null
	currentAudioObject: null,
	lastReplyText: "",
	// consecutive-interim counting for sustained-speech gate
	lastInterimText: "",
	interruptCandidateCount: 0,
	// kept briefly after a cut so a false trigger can resume where it left off
	// { audioUrl, currentTime, replyText } | null
	pausedForInterrupt: null,
	resumeTimerId: null,
	// final result indexes already sent to the LLM (Chrome re-fires onresult)
	processedFinalIndexes: new Set(),
};

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

function normalizeText(s) {
	return (s || "")
		.toLowerCase()
		.replace(/[^a-z0-9\s']/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// True when the interim looks like the AI hearing itself.
function isEchoOfReply(interimText, replyText) {
	const interim = normalizeText(interimText);
	const reply = normalizeText(replyText);
	if (!interim || !reply || interim.length < INTERRUPT_MIN_CHARS) return false;
	// Direct substring (most common echo case)
	if (reply.includes(interim) || interim.length >= 8) {
		if (reply.includes(interim)) return true;
	}
	// Word-overlap fallback: most interim words appear in the reply
	const interimWords = interim.split(" ").filter(Boolean);
	if (interimWords.length === 0) return false;
	const replyWordSet = new Set(reply.split(" ").filter(Boolean));
	const hits = interimWords.filter((w) => replyWordSet.has(w)).length;
	return hits / interimWords.length >= 0.6 && interimWords.length >= 2;
}

function cancelResumeTimer() {
	if (state.resumeTimerId !== null) {
		clearTimeout(state.resumeTimerId);
		state.resumeTimerId = null;
	}
}

// Cut the currently playing TTS immediately. Resolves the pending speak()
// promise so `isSpeaking` never gets stuck. Returns snapshot for resume.
function stopCurrentAudioForInterrupt(reason) {
	const current = state.currentAudioObject;
	if (!current) return null;
	try {
		current.audio.onended = null;
		current.audio.onerror = null;
		current.audio.pause();
	} catch (_) {}
	const snapshot = {
		audioUrl: current.audioUrl,
		currentTime: 0,
		replyText: current.replyText,
	};
	try {
		snapshot.currentTime = current.audio.currentTime || 0;
	} catch (_) {}
	state.currentAudioObject = null;
	state.currentlyPlaying = false;
	isSpeaking = false;
	if (!current.finished) {
		current.finished = true;
		try {
			current.resolve();
		} catch (_) {}
	}
	console.log(
		`[Interrupt] TTS cut (${reason}) at ${snapshot.currentTime.toFixed(2)}s`,
	);
	return snapshot;
}

function scheduleResume() {
	cancelResumeTimer();
	state.resumeTimerId = setTimeout(() => {
		state.resumeTimerId = null;
		const paused = state.pausedForInterrupt;
		// Only resume if nothing else took over (no new final, no new audio)
		if (paused && !state.currentAudioObject && isListening) {
			console.log(
				"[Interrupt] No follow-up speech — resuming TTS (false trigger).",
			);
			state.pausedForInterrupt = null;
			state.lastInterimText = "";
			state.interruptCandidateCount = 0;
			const epoch = requestEpoch;
			speak(paused.audioUrl, paused.replyText, epoch, paused.currentTime).catch(
				() => {},
			);
		}
	}, INTERRUPT_RESUME_DELAY_MS);
}

async function* llmStreaming(userText = "") {
	yield { textContect: "", isFinal: false };
}

// Play TTS audio. Mic is intentionally LEFT OPEN so interim results can
// trigger barge-in while the AI is speaking.
function speak(audioUrl, replyText = "", epoch = requestEpoch, startAt = 0) {
	return new Promise((resolve) => {
		if (!audioUrl) {
			resolve();
			return;
		}

		isSpeaking = true;
		state.currentlyPlaying = true;
		updateStatus("🔊 Speaking... (speak up to interrupt)");

		const audio = new Audio(audioUrl);
		const entry = {
			audio,
			audioUrl,
			startTime: Date.now(),
			epoch,
			replyText,
			finished: false,
			resolve,
		};
		state.currentAudioObject = entry;
		if (replyText) state.lastReplyText = replyText;

		const finishSpeaking = () => {
			if (entry.finished) return;
			entry.finished = true;
			if (state.currentAudioObject === entry) {
				state.currentAudioObject = null;
			}
			state.currentlyPlaying = false;
			isSpeaking = false;
			if (isListening) {
				updateStatus("🎤 Listening...");
			}
			resolve();
		};
		entry.finish = finishSpeaking;

		audio.onended = finishSpeaking;
		audio.onerror = (err) => {
			console.error("Audio playback error:", err);
			finishSpeaking();
		};

		const begin = () => {
			try {
				if (startAt > 0 && Number.isFinite(startAt)) {
					audio.currentTime = startAt;
				}
			} catch (_) {}
			audio.play().catch((err) => {
				console.error("Autoplay prevented:", err);
				finishSpeaking();
			});
		};
		// If resuming, the element may need a tick before seeking.
		if (startAt > 0) {
			audio.addEventListener("loadedmetadata", begin, { once: true });
			setTimeout(() => {
				if (!entry.finished && audio.paused) begin();
			}, 300);
		} else {
			begin();
		}
	});
}

// Called on qualifying interim speech while TTS is playing.
function handleBargeIn(interimText) {
	if (!state.currentlyPlaying) return;
	// Invalidate anything in flight (finish-but-don't-play for stale replies)
	requestEpoch += 1;
	const paused = stopCurrentAudioForInterrupt(`barge-in: "${interimText}"`);
	state.pausedForInterrupt = paused;
	state.lastInterimText = "";
	state.interruptCandidateCount = 0;
	updateStatus("🎤 Listening (you interrupted)...");
	// If the interim was echo and no real final follows, resume where we cut.
	scheduleResume();
}

// Fast path for interim results: detect natural interruption.
function maybeInterruptFromInterim(interimText, confidence) {
	if (!isListening || !state.currentlyPlaying || !state.currentAudioObject)
		return;
	const current = state.currentAudioObject;

	// 1. Grace window — echo spike right after play() starts.
	if (Date.now() - current.startTime < INTERRUPT_GRACE_MS) return;

	const text = (interimText || "").trim();
	// 2. Minimum strength.
	if (text.length < INTERRUPT_MIN_CHARS) return;
	if (
		typeof confidence === "number" &&
		confidence >= 0 &&
		confidence < INTERRUPT_MIN_CONFIDENCE
	) {
		return;
	}
	// 3. Self-text match — AI hearing its own voice.
	if (isEchoOfReply(text, current.replyText || state.lastReplyText)) {
		return;
	}
	// 4. Sustained speech — require consecutive interim frames, not one blip.
	const norm = normalizeText(text);
	const prev = normalizeText(state.lastInterimText);
	if (
		prev &&
		(norm.startsWith(prev) || prev.startsWith(norm) || norm.includes(prev))
	) {
		state.interruptCandidateCount += 1;
	} else {
		state.interruptCandidateCount = 1;
	}
	state.lastInterimText = text;
	if (state.interruptCandidateCount < INTERRUPT_REQUIRED_CONSECUTIVE) return;

	handleBargeIn(text);
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

// Final (confirmed) user speech -> LLM -> TTS, with stale-epoch drop.
async function handleFinalTranscript(transcript) {
	if (!isListening) return;
	const myEpoch = ++requestEpoch;
	// Real user speech arrived: this was not a false trigger.
	cancelResumeTimer();
	state.pausedForInterrupt = null;
	state.lastInterimText = "";
	state.interruptCandidateCount = 0;

	console.log("User:", transcript);
	appendMessage("user", transcript);

	const data = await llm(transcript);
	if (myEpoch !== requestEpoch) {
		// A newer turn / barge-in superseded this one: show text, skip audio.
		console.log(
			`[Stale] Dropping audio for superseded turn (epoch ${myEpoch} != ${requestEpoch}).`,
		);
		console.log("AI (dropped audio):", data.reply);
		appendMessage("ai", data.reply);
		return;
	}
	console.log("AI:", data.reply);
	appendMessage("ai", data.reply);

	if (data.audio) {
		await speak(data.audio, data.reply, myEpoch);
	} else if (isListening && !state.currentlyPlaying) {
		updateStatus("🎤 Listening...");
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
	sr.interimResults = true; // required for instant barge-in
	sr.maxAlternatives = 1;
	sr.lang = "en-US";

	sr.onstart = function () {
		// Don't clobber the "Speaking" indicator while TTS plays.
		if (!state.currentlyPlaying && !isSpeaking && isListening) {
			updateStatus("🎤 Listening...");
		}
	};

	sr.onerror = function (event) {
		console.warn("Speech recognition error:", event.error);
		if (event.error === "no-speech" || event.error === "aborted") {
			return; // silence timeouts / intentional restarts
		}
		if (event.error === "network") {
			updateStatus("❌ Network error: Check internet/mic or run on localhost.");
		} else if (
			event.error === "not-allowed" ||
			event.error === "service-not-allowed"
		) {
			updateStatus("❌ Mic blocked: allow microphone permission and reload.");
			isListening = false;
			if (toggleBtn) {
				toggleBtn.textContent = "Start Listening";
				toggleBtn.classList.remove("listening");
			}
		}
	};

	sr.onend = function () {
		// Mic stays open across TTS now: always restart while agent is on.
		// (Previously gated on !isSpeaking, which killed barge-in entirely.)
		if (isListening) {
			try {
				sr.start();
			} catch (_) {}
		}
	};

	sr.onresult = function (event) {
		if (!isListening) return;
		for (let i = event.resultIndex; i < event.results.length; i += 1) {
			const result = event.results[i];
			const alt = result[0];
			if (!alt) continue;
			const transcript = (alt.transcript || "").trim();
			if (!transcript) continue;
			if (result.isFinal) {
				if (state.processedFinalIndexes.has(i)) continue;
				state.processedFinalIndexes.add(i);
				// Keep the set bounded for long sessions.
				if (state.processedFinalIndexes.size > 200) {
					const oldest = [...state.processedFinalIndexes].slice(0, 100);
					oldest.forEach((k) => state.processedFinalIndexes.delete(k));
				}
				handleFinalTranscript(transcript).catch((err) =>
					console.error("Final handling error:", err),
				);
			} else {
				const confidence =
					typeof alt.confidence === "number" ? alt.confidence : undefined;
				maybeInterruptFromInterim(transcript, confidence);
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
				requestEpoch += 1;
				state.processedFinalIndexes.clear();
				state.pausedForInterrupt = null;
				cancelResumeTimer();
				toggleBtn.textContent = "Stop Agent";
				toggleBtn.classList.add("listening");
				updateStatus("🎤 Starting microphone...");
				try {
					speechRecognition.start();
				} catch (_) {}
			} else {
				isListening = false;
				requestEpoch += 1; // invalidate in-flight turns
				cancelResumeTimer();
				state.pausedForInterrupt = null;
				stopCurrentAudioForInterrupt("agent stopped");
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
