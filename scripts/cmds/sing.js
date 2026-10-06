const fs = require("fs-extra");
const axios = require("axios");

function formatDuration(ms) {
	if (!ms)
		return "";
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

function extensionFrom(contentType) {
	if (!contentType)
		return "m4a";
	const type = String(contentType).toLowerCase();
	if (type.includes("mpeg") || type.includes("mp3"))
		return "mp3";
	if (type.includes("aac"))
		return "aac";
	if (type.includes("wav"))
		return "wav";
	if (type.includes("ogg"))
		return "ogg";
	return "m4a";
}

module.exports = {
	config: {
		name: "sing",
		aliases: ["music", "song"],
		version: "1.0",
		author: "Neoaz 🐊",
		countDown: 5,
		role: 0,
		description: {
			en: "Search and send songs from Facebook Music"
		},
		category: "media",
		guide: {
			en: "   {pn} <song name>: find and send the best match"
				+ "\n   {pn} <song name> -c <count>: choose from the result list"
				+ "\n   Example:"
				+ "\n    {pn} Khat"
				+ "\n    {pn} Khat -c 10"
		}
	},

	langs: {
		en: {
			notFound: "❌ No song matched \"%1\".",
			choose: "🎵 Results for \"%1\":\n%2\nReply with a number to choose or any content to cancel.",
			invalidChoice: "❌ Invalid choice, cancelled.",
			error: "❌ An error occurred: %1",
			unsupported: "❌ Unsupported song format."
		}
	},

	onStart: async function ({ api, args, message, event, commandName, getLang }) {
		let count = 0;
		const countIndex = args.findIndex(a => a === "-c" || a === "-v" || a === "--v");
		if (countIndex !== -1) {
			const parsed = parseInt(args[countIndex + 1]);
			if (!isNaN(parsed) && parsed > 0)
				count = Math.min(parsed, 25);
			args = args.slice();
			args.splice(countIndex, 2);
		}

		const query = args.join(" ").trim();
		if (!query)
			return message.SyntaxError();

		await message.reaction("⏳", event.messageID);

		let results;
		try {
			results = await api.searchMusic(query, { limit: Math.max(count, 1), exact: false });
		}
		catch (err) {
			await message.reaction("❌", event.messageID);
			return message.reply(getLang("error", err.message || JSON.stringify(err)));
		}

		const playable = (results || []).filter(track => track.url);
		if (!playable.length) {
			await message.reaction("❌", event.messageID);
			return message.reply(getLang("notFound", query));
		}

		if (count > 0) {
			const list = playable.slice(0, count);
			let body = "";
			let index = 1;
			const thumbnails = [];
			for (const track of list) {
				body += `${index++}. ${track.title} - ${track.artist}${track.duration ? ` (${formatDuration(track.duration)})` : ""}\n`;
				if (track.image)
					thumbnails.push(global.utils.getStreamFromURL(track.image));
			}
			const attachments = await Promise.all(thumbnails.map(p => p.catch(() => null)));
			const messageInfo = await message.reply({
				body: getLang("choose", query, body),
				attachment: attachments.filter(Boolean)
			});
			global.GoatBot.onReply.set(messageInfo.messageID, {
				commandName,
				messageID: messageInfo.messageID,
				author: event.senderID,
				results: list
			});
			await message.reaction("✅", event.messageID);
			return;
		}

		await sendTrack({ api, message, event, getLang, track: playable[0] });
	},

	onReply: async function ({ api, event, message, Reply, getLang }) {
		const choice = parseInt(event.body);
		if (isNaN(choice) || choice < 1 || choice > Reply.results.length) {
			await api.unsendMessage(Reply.messageID);
			return message.reply(getLang("invalidChoice"));
		}
		const track = Reply.results[choice - 1];
		await api.unsendMessage(Reply.messageID);
		await message.reaction("⏳", event.messageID);
		await sendTrack({ api, message, event, getLang, track });
	}
};

async function sendTrack({ api, message, event, getLang, track }) {
	const tempPath = `${__dirname}/tmp/music_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
	let filePath = null;
	try {
		const response = await axios({
			url: track.url,
			method: "GET",
			responseType: "stream",
			timeout: 60000
		});
		const extension = extensionFrom(response.headers && response.headers["content-type"]);
		filePath = `${tempPath}.${extension}`;
		await new Promise((resolve, reject) => {
			const writeStream = fs.createWriteStream(filePath);
			response.data.pipe(writeStream);
			writeStream.on("finish", resolve);
			writeStream.on("error", reject);
			response.data.on("error", reject);
		});

		const size = fs.statSync(filePath).size;
		if (!size)
			throw new Error(getLang("unsupported"));

		const caption = `${track.title} - ${track.artist}`;
		await new Promise((resolve, reject) => {
			message.reply({
				body: caption,
				attachment: fs.createReadStream(filePath)
			}, (err) => err ? reject(err) : resolve());
		});

		await message.reaction("✅", event.messageID);
	}
	catch (err) {
		await message.reaction("❌", event.messageID);
		return message.reply(getLang("error", err.message || JSON.stringify(err)));
	}
	finally {
		if (filePath && fs.existsSync(filePath))
			fs.unlinkSync(filePath);
	}
}
