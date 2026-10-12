module.exports = {
	config: {
		name: "music",
		aliases: ["ms", "msticker"],
		version: "1.0",
		author: "Neoaz 🐊",
		countDown: 5,
		role: 0,
		description: {
			en: "Search and send songs as Messenger music stickers"
		},
		category: "media",
		guide: {
			en: "   {pn} <song name>: send the best match as a music sticker"
				+ "\n   {pn} <song name> -c <count>: choose from the result list"
				+ "\n   Example:"
				+ "\n    {pn} Khat"
				+ "\n    {pn} Cook Pardon -c 10"
		}
	},

	langs: {
		en: {
			notFound: "❌ No song matched \"%1\".",
			choose: "🎵 Results for \"%1\":\n%2\nReply with a number to choose or any content to cancel.",
			invalidChoice: "❌ Invalid choice, cancelled.",
			error: "❌ An error occurred: %1"
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

		// searchMusic ranks category containers ("MediaTag") alongside real tracks,
		// so the top row is sometimes not playable. Pull a candidate pool and
		// filter to sticker-capable tracks before applying the count.
		const poolSize = count > 0 ? Math.max(count * 3, 30) : 30;
		let results;
		try {
			results = await api.searchMusic(query, { limit: poolSize, first: Math.max(poolSize, 30), exact: false });
		}
		catch (err) {
			await message.reaction("❌", event.messageID);
			return message.reply(getLang("error", err.message || JSON.stringify(err)));
		}

		const playable = (results || []).filter(track => track.songId);
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

		await sendSticker({ api, message, event, getLang, track: playable[0] });
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
		await sendSticker({ api, message, event, getLang, track });
	}
};

function formatDuration(ms) {
	if (!ms)
		return "";
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

async function sendSticker({ api, message, event, getLang, track }) {
	try {
		await api.sendMusicSticker(track, event.threadID);
		await message.reaction("✅", event.messageID);
	}
	catch (err) {
		await message.reaction("❌", event.messageID);
		return message.reply(getLang("error", err.message || JSON.stringify(err)));
	}
}
