const API_URL =
	window.location.port === "5000"
		? "/api/chat"
		: "http://localhost:5000/api/chat";

async function llm(userText) {
	try {
		const response = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ userText }),
		});

		if (!response.ok) {
			const errorData = await response.json();
			throw new Error(errorData.error || `HTTP error ${response.status}`);
		}

		const data = await response.json();
		return data.reply ?? "";
	} catch (error) {
		console.error("Error communicating with LLM server:", error);
		return `Error: ${error.message}`;
	}
}

function main() {
	const SpeechRecognition =
		window.SpeechRecognition || window.webkitSpeechRecognition;

	if (!SpeechRecognition) {
		console.error("SpeechRecognition is not supported in this browser.");
		return;
	}

	const speechRecognition = new SpeechRecognition();

	speechRecognition.continuous = true;
	speechRecognition.interimResults = false;
	speechRecognition.maxAlternatives = 1;
	speechRecognition.lang = "en-US";

	speechRecognition.onstart = function () {
		console.log("🎤 speech has started");
	};

	speechRecognition.onerror = function (event) {
		console.error("Speech recognition error:", event.error);
	};

	speechRecognition.onend = function () {
		console.log("Speech recognition ended");
	};

	speechRecognition.onresult = async function (event) {
		const transcript = event.results[event.results.length - 1][0].transcript;
		console.log("User: ", transcript);

		const llmResponse = await llm(transcript);
		console.log("LLM Response: ", llmResponse);
	};

	speechRecognition.start();
}

main();
