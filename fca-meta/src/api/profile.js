"use strict";

const { getType, isReadableStream, streamToBuffer } = require("../utils");
const { httpPost, httpPostFormData } = require("./http");
const { guessMime } = require("./upload");

const POST_REACTIONS = {
  unlike: 0,
  like: 1,
  heart: 2,
  love: 16,
  haha: 4,
  wow: 3,
  sad: 7,
  angry: 8,
};

async function changeBio(client, bio, publish) {
  if (getType(bio) !== "String") {
    bio = "";
    publish = false;
  }
  if (getType(publish) !== "Boolean") publish = false;
  await httpPost(client, "https://www.facebook.com/api/graphql/", {
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "ProfileCometSetBioMutation",
    doc_id: "2725043627607610",
    variables: JSON.stringify({
      input: {
        bio,
        publish_bio_feed_story: publish,
        actor_id: client.getCurrentUserID(),
        client_mutation_id: Math.round(Math.random() * 1024).toString(),
      },
      hasProfileTileViewID: false,
      profileTileViewID: null,
      scale: 1,
    }),
    av: client.getCurrentUserID(),
  });
  return {};
}

async function changeAvatar(client, image, caption = "", timestamp = null) {
  if (getType(caption) === "Number") {
    timestamp = caption;
    caption = "";
  }
  if (!isReadableStream(image) && !Buffer.isBuffer(image)) return { error: "Image is not a readable stream" };
  const buffer = Buffer.isBuffer(image) ? image : await streamToBuffer(image);
  const mimeType = (image && image.mimeType) || guessMime((image && image.filename) || "avatar.jpg");
  const filename = (image && image.filename) || "avatar.jpg";

  const upload = await httpPostFormData(client, "https://www.facebook.com/profile/picture/upload/", {
    profile_id: client.getCurrentUserID(),
    photo_source: 57,
    av: client.getCurrentUserID(),
    file: new Blob([buffer], { type: mimeType }),
  });
  const fbid = upload && upload.payload ? upload.payload.fbid : upload && upload.fbid;
  if (!fbid) return { error: "Failed to upload profile picture" };

  const res = await httpPost(client, "https://www.facebook.com/api/graphql/", {
    av: client.getCurrentUserID(),
    fb_api_req_friendly_name: "ProfileCometProfilePictureSetMutation",
    fb_api_caller_class: "RelayModern",
    doc_id: "5066134240065849",
    variables: JSON.stringify({
      input: {
        caption,
        existing_photo_id: fbid,
        expiration_time: timestamp,
        profile_id: client.getCurrentUserID(),
        profile_pic_method: "EXISTING",
        profile_pic_source: "TIMELINE",
        scaled_crop_rect: { height: 1, width: 1, x: 0, y: 0 },
        skip_cropping: true,
        actor_id: client.getCurrentUserID(),
        client_mutation_id: Math.round(Math.random() * 19).toString(),
      },
      isPage: false,
      isProfile: true,
      scale: 3,
    }),
  });
  return res && res.data ? res.data.profile_picture_set : res;
}

async function setPostReaction(client, postID, type) {
  if (getType(type) === "String") type = POST_REACTIONS[type.toLowerCase()];
  if (getType(type) !== "Number") type = 0;
  const res = await httpPost(client, "https://www.facebook.com/api/graphql/", {
    av: client.getCurrentUserID(),
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "CometUFIFeedbackReactMutation",
    doc_id: "4769042373179384",
    variables: JSON.stringify({
      input: {
        actor_id: client.getCurrentUserID(),
        feedback_id: Buffer.from("feedback:" + postID).toString("base64"),
        feedback_reaction: type,
        feedback_source: "OBJECT",
        is_tracking_encrypted: true,
        tracking: [],
        session_id: "f7dd50dd-db6e-4598-8cd9-561d5002b423",
        client_mutation_id: Math.round(Math.random() * 19).toString(),
      },
      useDefaultActor: false,
      scale: 3,
    }),
  });
  return res && res.data ? res.data : res;
}

module.exports = { changeBio, changeAvatar, setPostReaction, POST_REACTIONS };
