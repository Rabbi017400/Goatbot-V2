const axios = require("axios");

module.exports = {
  config: {
    name: "meme",
    aliases: [],
    version: "1.1",
    author: "Neoaz 🐊",
    countDown: 5,
    role: 0,
    shortDescription: { en: "Fetch memes from Reddit" },
    longDescription: { en: "Fetch single or multiple memes from random or specific subreddits." },
    category: "fun",
    guide: { en: "{pn} | {pn} -r <subreddit> | {pn} -c <count> | {pn} -r <subreddit> -c <count>" }
  },

  onStart: async function ({ message, args, api, event }) {
    let subreddit = "";
    let count = 1;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-r" && args[i + 1]) {
        subreddit = args[i + 1];
        i++;
      } else if (args[i] === "-c" && args[i + 1]) {
        const parsedCount = parseInt(args[i + 1], 10);
        if (!isNaN(parsedCount)) {
          count = Math.min(Math.max(parsedCount, 1), 50);
        }
        i++;
      }
    }

    let apiUrl = "https://meme-api.com/gimme";
    if (subreddit && count > 1) {
      apiUrl = `https://meme-api.com/gimme/${encodeURIComponent(subreddit)}/${count}`;
    } else if (subreddit) {
      apiUrl = `https://meme-api.com/gimme/${encodeURIComponent(subreddit)}`;
    } else if (count > 1) {
      apiUrl = `https://meme-api.com/gimme/${count}`;
    }

    if (event?.messageID && api?.setMessageReaction) {
      api.setMessageReaction("🐸", event.messageID, () => {}, true);
    }

    try {
      const res = await axios.get(apiUrl);
      const data = res.data;

      const memes = count > 1 ? data.memes : [data];

      if (!memes || memes.length === 0) {
        if (event?.messageID && api?.setMessageReaction) api.setMessageReaction("❌", event.messageID, () => {}, true);
        return message.reply("No memes found.");
      }

      const attachments = [];
      const captionLines = [];

      for (let i = 0; i < memes.length; i++) {
        const meme = memes[i];
        if (!meme.url) continue;

        try {
          const imgRes = await axios.get(meme.url, { responseType: "stream" });
          attachments.push(imgRes.data);
          captionLines.push(`${meme.title} (r/${meme.subreddit})`);
        } catch (e) {
        }
      }

      if (attachments.length === 0) {
        if (event?.messageID && api?.setMessageReaction) api.setMessageReaction("❌", event.messageID, () => {}, true);
        return message.reply("Failed to load meme images.");
      }

      await message.reply({
        body: captionLines.join("\n\n"),
        attachment: attachments
      });

      if (event?.messageID && api?.setMessageReaction) api.setMessageReaction("✅", event.messageID, () => {}, true);
    } catch (err) {
      if (event?.messageID && api?.setMessageReaction) api.setMessageReaction("❌", event.messageID, () => {}, true);
      const errMessage = err.response?.data?.message || err.message || "Error fetching memes.";
      message.reply(`Failed to get memes: ${errMessage}`);
    }
  }
};
