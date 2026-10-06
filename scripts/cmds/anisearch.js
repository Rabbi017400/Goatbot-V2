const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");

module.exports = {
  config: {
    name: "anitik",
    aliases: ["anisearch"],
    version: "1.3",
    author: "Tenzo",
    countDown: 5,
    role: 0,
    shortDescription: "Random anime TikTok video",
    category: "media",
    guide: { en: "{pn} <anime name>" }
  },
  onStart: async function ({ api, args, event, message }) {
    const query = args.join(" ").trim();
    if (!query) return message.reply("Usage: anitik <anime name>");

    const cacheDir = path.join(__dirname, "cache");
    await fs.ensureDir(cacheDir);
    const filePath = path.join(cacheDir, `anitik_${Date.now()}.mp4`);

    try {
      const res = await axios.get(
        `https://mahis-global-apis.vercel.app/api/media/anitik?q=${encodeURIComponent(query)}`
      );
      const results = res.data?.results || [];
      if (!results.length) {
        api.setMessageReaction("❌", event.messageID, () => {}, true);
        return message.reply(`No TikTok results for "${query}".`);
      }

      const picked = results[Math.floor(Math.random() * results.length)];
      const videoUrl = picked.video_url;
      if (!videoUrl) throw new Error("No video URL in result");

      api.setMessageReaction("⏳", event.messageID, () => {}, true);
      const stream = await axios({
        url: videoUrl,
        method: "GET",
        responseType: "stream",
        timeout: 60000,
        headers: { "User-Agent": "Mozilla/5.0" },
        validateStatus: s => s >= 200 && s < 400
      });
      const writer = fs.createWriteStream(filePath);
      stream.data.pipe(writer);
      await new Promise((res, rej) => {
        writer.on("finish", res);
        writer.on("error", rej);
      });
      const stat = await fs.stat(filePath);
      if (stat.size < 1024) throw new Error("File too small - download failed");

      api.setMessageReaction("✅", event.messageID, () => {}, true);
      await message.reply({
        body: picked.title?.slice(0, 200) || "Anime TikTok",
        attachment: fs.createReadStream(filePath)
      });
      setTimeout(() => fs.unlink(filePath).catch(() => {}), 15000);
    } catch (e) {
      api.setMessageReaction("❌", event.messageID, () => {}, true);
      if (fs.existsSync(filePath)) fs.unlink(filePath).catch(() => {});
      return message.reply(`AniTik failed: ${e.response?.status || ""} ${e.message}`.slice(0, 600));
    }
  }
};
