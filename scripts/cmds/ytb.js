const axios = require("axios");
const fs = require("fs-extra");
const { getStreamFromURL, formatNumber } = global.utils;

const BASE_URL = "https://dl.neokex.xyz";

async function getStreamAndSize(url, path = "") {
	const response = await axios({
		method: "GET",
		url,
		responseType: "stream",
		headers: {
			'Range': 'bytes=0-'
		}
	});
	if (path)
		response.data.path = path;
	const totalLength = response.headers["content-length"];
	return {
		stream: response.data,
		size: totalLength
	};
}

async function fetchDownload(url) {
	try {
		const { data } = await axios.get(`${BASE_URL}/dl`, {
			params: { url },
			timeout: 60000
		});
		if (!data || !data.status || !data.result)
			throw new Error((data && data.message) || "Failed to fetch media");
		return data.result;
	}
	catch (err) {
		throw new Error(err?.response?.data?.message || err.message);
	}
}

async function searchVideos(keyWord) {
	try {
		const { data } = await axios.get(`${BASE_URL}/yts`, {
			params: { q: keyWord },
			timeout: 60000
		});
		if (!data || !data.status || !data.result)
			throw new Error((data && data.message) || "Failed to search videos");
		return data.result.items || [];
	}
	catch (err) {
		throw new Error(err?.response?.data?.message || err.message);
	}
}

function formatDuration(seconds) {
	if (seconds === null || seconds === undefined || isNaN(seconds))
		return "Unknown";
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor(seconds % 3600 / 60);
	const secs = Math.floor(seconds % 60);
	return `${hours ? hours + ":" : ""}${minutes < 10 ? "0" + minutes : minutes}:${secs < 10 ? "0" + secs : secs}`;
}

async function sendMedia({ type, result, message, getLang }) {
	const { title, media = [] } = result;
	const entry = media.find(m => m.type === type);
	if (!entry)
		return message.reply(getLang(type == "video" ? "noVideo" : "noAudio"));

	const MAX_SIZE = type == "video" ? 83 * 1024 * 1024 : 27262976;
	const ext = type == "video" ? "mp4" : "mp3";
	const msgSend = message.reply(getLang("downloading", getLang(type), title));
	const getStream = await getStreamAndSize(entry.url, `${Date.now()}.${ext}`);
	const contentLength = Number(getStream.size);
	if (contentLength && contentLength > MAX_SIZE)
		return message.reply(getLang(type == "video" ? "noVideo" : "noAudio"));

	const savePath = __dirname + `/tmp/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
	const writeStream = fs.createWriteStream(savePath);
	const startTime = Date.now();
	getStream.stream.pipe(writeStream);
	let downloaded = 0;
	let count = 0;

	getStream.stream.on("data", (chunk) => {
		downloaded += chunk.length;
		count++;
		if (count == 5 && contentLength) {
			const endTime = Date.now();
			const speed = downloaded / (endTime - startTime) * 1000;
			const timeLeft = (contentLength / downloaded * (endTime - startTime)) / 1000;
			const percent = downloaded / contentLength * 100;
			if (timeLeft > 30)
				message.reply(getLang("downloading2", getLang(type), title, Math.floor(speed / 1000) / 1000, Math.floor(downloaded / 1000) / 1000, Math.floor(contentLength / 1000) / 1000, Math.floor(percent), timeLeft.toFixed(2)));
		}
	});

	writeStream.on("finish", () => {
		message.reply({
			body: title,
			attachment: fs.createReadStream(savePath)
		}, async (err) => {
			if (err)
				return message.reply(getLang("error", err.message));
			fs.unlinkSync(savePath);
			message.unsend((await msgSend).messageID);
		});
	});
}

async function handle({ type, result, message, getLang, videoUrl }) {
	if (type == "info") {
		const { title, duration, author, stats, thumbnail } = result;
		const lines = [
			getLang("infoTitle", title || "Unknown"),
			getLang("infoChannel", author?.name || "Unknown")
		];
		if (duration)
			lines.push(getLang("infoDuration", formatDuration(duration)));
		if (stats?.views)
			lines.push(getLang("infoViews", formatNumber(stats.views)));
		if (stats?.likes)
			lines.push(getLang("infoLikes", formatNumber(stats.likes)));
		lines.push(getLang("infoLink", videoUrl || "-"));
		const payload = { body: lines.join("\n") };
		if (thumbnail)
			payload.attachment = await getStreamFromURL(thumbnail);
		return message.reply(payload);
	}
	return sendMedia({ type, result, message, getLang });
}

module.exports = {
	config: {
		name: "ytb",
		version: "2.0",
		author: "NeoKEX",
		countDown: 5,
		role: 0,
		description: {
			en: "Download video, audio or view video information on YouTube"
		},
		category: "media",
		guide: {
			en: "   {pn} [video|-v] [<video name>|<video link>]: use to download video from youtube."
				+ "\n   {pn} [audio|-a] [<video name>|<video link>]: use to download audio from youtube"
				+ "\n   {pn} [info|-i] [<video name>|<video link>]: use to view video information from youtube"
				+ "\n   Example:"
				+ "\n    {pn} -v Fallen Kingdom"
				+ "\n    {pn} -a Fallen Kingdom"
				+ "\n    {pn} -i Fallen Kingdom"
		}
	},

	langs: {
		en: {
			error: "• An error occurred: %1",
			noResult: "• No search results match the keyword %1",
			choose: "%1Reply to the message with a number to choose or any content to cancel",
			video: "video",
			audio: "audio",
			downloading: "• Downloading %1 \"%2\"",
			downloading2: "• Downloading %1 \"%2\"\n• Speed: %3MB/s\n• Downloaded: %4/%5MB (%6%)\n• Estimated time remaining: %7 seconds",
			noVideo: "• Sorry, no video was found with a size less than 83MB",
			noAudio: "• Sorry, no audio was found with a size less than 26MB",
			infoTitle: "• Title: %1",
			infoChannel: "• Channel: %1",
			infoDuration: "• Duration: %1",
			infoViews: "• Views: %1",
			infoLikes: "• Likes: %1",
			infoLink: "• Link: %1"
		}
	},

	onStart: async function ({ args, message, event, commandName, getLang }) {
		let type;
		switch (args[0]) {
			case "-v":
			case "video":
				type = "video";
				break;
			case "-a":
			case "-s":
			case "audio":
			case "sing":
				type = "audio";
				break;
			case "-i":
			case "info":
				type = "info";
				break;
			default:
				return message.SyntaxError();
		}

		const input = args.slice(1).join(" ").trim();
		if (!input)
			return message.SyntaxError();

		const checkurl = /^(?:https?:\/\/)?(?:m\.|www\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))((\w|-){11})(?:\S+)?$/;

		if (checkurl.test(input)) {
			let result;
			try {
				result = await fetchDownload(input);
			}
			catch (err) {
				return message.reply(getLang("error", err.message));
			}
			return handle({ type, result, message, getLang, videoUrl: input });
		}

		const keyWord = input.includes("?feature=share") ? input.replace("?feature=share", "") : input;
		const maxResults = 6;

		let results;
		try {
			results = (await searchVideos(keyWord)).slice(0, maxResults);
		}
		catch (err) {
			return message.reply(getLang("error", err.message));
		}
		if (results.length == 0)
			return message.reply(getLang("noResult", keyWord));

		let msg = "";
		let i = 1;
		const thumbnails = [];
		const arrayID = [];

		for (const info of results) {
			thumbnails.push(getStreamFromURL(info.thumbnail));
			msg += `${i++}. ${info.title}\nTime: ${formatDuration(info.duration)}\nChannel: ${info.author?.name || "Unknown"}\n\n`;
		}

		message.reply({
			body: getLang("choose", msg),
			attachment: await Promise.all(thumbnails)
		}, (err, info) => {
			global.GoatBot.onReply.set(info.messageID, {
				commandName,
				messageID: info.messageID,
				author: event.senderID,
				arrayID,
				results,
				type
			});
		});
	},

	onReply: async function ({ event, api, Reply, message, getLang }) {
		const { results, type } = Reply;
		const choice = event.body;
		if (!isNaN(choice) && choice >= 1 && choice <= 6) {
			const infoChoice = results[choice - 1];
			api.unsendMessage(Reply.messageID);
			let result;
			try {
				result = await fetchDownload(infoChoice.url);
			}
			catch (err) {
				return message.reply(getLang("error", err.message));
			}
			await handle({ type, result, message, getLang, videoUrl: infoChoice.url });
		}
		else
			api.unsendMessage(Reply.messageID);
	}
};
