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
	};

	speechRecognition.start();
}

main();
