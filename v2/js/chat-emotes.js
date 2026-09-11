(function () {
  window.Chat = window.Chat || {};

  function selectSevenTvImage(emote) {
    var host = emote && emote.data && emote.data.host;
    var files = host && Array.isArray(host.files) ? host.files : [];
    var usable = files.filter(function (file) {
      return file && typeof file.name === "string" && file.name.length > 0;
    });

    if (!host || typeof host.url !== "string" || !usable.length) return null;

    function isAnimated(file) {
      var frameCount = file.frame_count;
      if (frameCount == null) frameCount = file.frameCount;
      return Number(frameCount) > 1;
    }

    function isWebp(file) {
      return (
        typeof file.format === "string" &&
        file.format.trim().toUpperCase() === "WEBP"
      );
    }

    function pixelCount(file) {
      var width = Number(file.width);
      var height = Number(file.height);
      if (!Number.isFinite(width) || width < 1) width = 0;
      if (!Number.isFinite(height) || height < 1) height = 0;
      return width * height;
    }

    function largest(candidates) {
      return candidates.slice().sort(function (a, b) {
        return pixelCount(b) - pixelCount(a);
      })[0] || null;
    }

    var animated =
      emote.animated === true ||
      (emote.data && emote.data.animated === true) ||
      usable.some(isAnimated);
    var webp = usable.filter(isWebp);
    var file = largest(
      usable.filter(function (candidate) {
        return animated && isAnimated(candidate) && isWebp(candidate);
      }),
    );

    if (!file && animated) file = largest(usable.filter(isAnimated));
    if (!file) file = largest(webp);
    if (!file) file = largest(usable);

    return file ? "https:" + host.url + "/" + file.name : null;
  }

  $.extend(Chat, {
    loadGlobalEmotes: function () {
      if (Chat.info.globalEmotesStarted) return;
      Chat.info.globalEmotesStarted = true;
      Chat.loadEmotes();
    },

    loadEmotes: function (channelID) {
      var channelResources = Boolean(channelID);
      if (
        channelResources &&
        (!Chat.isPlatformEnabled("twitch") || Chat.info.preview)
      ) return;
      var generation = Chat.info.startupGeneration;
      function active() {
        return !channelResources || (
          generation === Chat.info.startupGeneration &&
          Chat.isPlatformEnabled("twitch")
        );
      }
      // Keep native emotes already registered by other platforms.
      var endpoints = channelResources
        ? ["users/twitch/" + encodeURIComponent(channelID)]
        : ["emotes/global"];
      // Load BTTV, FFZ and 7TV emotes
      endpoints.forEach(
        (endpoint) => {
          $.getJSON(
            "https://api.betterttv.net/3/cached/frankerfacez/" + endpoint,
          ).done(function (res) {
            if (!active() || !Array.isArray(res)) return;
            res.forEach((emote) => {
              if (emote.images["4x"]) {
                var imageUrl = emote.images["4x"];
                var upscale = false;
              } else {
                var imageUrl = emote.images["2x"] || emote.images["1x"];
                var upscale = true;
              }
              Chat.info.emotes[emote.code] = {
                id: emote.id,
                image: imageUrl,
                upscale: upscale,
              };
            });
          });
        },
      );

      endpoints.forEach(
        (endpoint) => {
          $.getJSON("https://api.betterttv.net/3/cached/" + endpoint).done(
            function (res) {
              if (!active() || !res) return;
              if (!Array.isArray(res)) {
                res = (res.channelEmotes || []).concat(res.sharedEmotes || []);
              }
              res.forEach((emote) => {
                Chat.info.emotes[emote.code] = {
                  id: emote.id,
                  image: "https://cdn.betterttv.net/emote/" + emote.id + "/3x",
                  zeroWidth: [
                    "5e76d338d6581c3724c0f0b2",
                    "5e76d399d6581c3724c0f0b8",
                    "567b5b520e984428652809b6",
                    "5849c9a4f52be01a7ee5f79d",
                    "567b5c080e984428652809ba",
                    "567b5dc00e984428652809bd",
                    "58487cc6f52be01a7ee5f205",
                    "5849c9c8f52be01a7ee5f79e",
                  ].includes(emote.id), // "5e76d338d6581c3724c0f0b2" => cvHazmat, "5e76d399d6581c3724c0f0b8" => cvMask, "567b5b520e984428652809b6" => SoSnowy, "5849c9a4f52be01a7ee5f79d" => IceCold, "567b5c080e984428652809ba" => CandyCane, "567b5dc00e984428652809bd" => ReinDeer, "58487cc6f52be01a7ee5f205" => SantaHat, "5849c9c8f52be01a7ee5f79e" => TopHat
                };
              });
            },
          );
        },
      );

      if (!channelResources) {
        $.getJSON("https://7tv.io/v3/emote-sets/global").done(function (res) {
          if (!res || !res.emotes) return;

          res.emotes.forEach((emote) => {
            if (
              !emote.data || !emote.data.host ||
              !emote.data.host.files || !emote.data.host.files.length
            ) return;

            var image = selectSevenTvImage(emote);
            if (!image) return;

            Chat.info.emotes[emote.name] = {
              id: emote.id,
              image: image,
              zeroWidth: emote.data.flags === 256,
            };
          });
        });
        return;
      }

      function processSevenTvChannelEmotes(emotes) {
        if (!active()) return;
        emotes.forEach((emote) => {
          if (
            !emote.data || !emote.data.host ||
            !emote.data.host.files || !emote.data.host.files.length
          ) return;

          var image = selectSevenTvImage(emote);
          if (!image) return;

          Chat.info.emotes[emote.name] = {
            id: emote.id,
            image: image,
            zeroWidth: emote.data.flags === 256,
          };
        });
      }

      $.getJSON("https://7tv.io/v3/users/twitch/" + encodeURIComponent(channelID))
        .done(function (res) {
          if (!active() || !res) return;

          var emoteSetId = res.emote_set_id;
          if (emoteSetId) {
            $.getJSON(
              "https://7tv.io/v3/emote-sets/" +
                encodeURIComponent(emoteSetId),
            )
              .done(function (emoteSet) {
                if (!emoteSet || !emoteSet.emotes) return;

                processSevenTvChannelEmotes(emoteSet.emotes);
              })
              .fail(function () {
                console.warn("jChat: Failed to load 7TV channel emotes.");
              });
            return;
          }

          if (res.emote_set && res.emote_set.emotes) {
            processSevenTvChannelEmotes(res.emote_set.emotes);
          }
        })
        .fail(function (xhr) {
          if (xhr && xhr.status === 404) return;
          console.warn("jChat: Failed to load 7TV channel emotes.");
        });
    },
  });
})();
