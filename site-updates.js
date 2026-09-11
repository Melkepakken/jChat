// Add an entry below using YYYY-MM-DD dates. The newest dates appear first.
// Use type: "update" for news, or type: "incident" with active: true for a notice.
// Set an incident's active field to false when it is resolved.
window.JCHAT_UPDATES = [
  {
    type: "update",
    date: "2026-09-12",
    title: "Smarter YouTube live discovery",
    summary:
      "jChat+ now avoids unnecessary repeated YouTube searches while still checking regularly for new live streams.",
  },
  {
    type: "update",
    date: "2026-09-06",
    title: "More Twitch GIF controls",
    summary:
      "Twitch GIFs now have Small, Medium and Large sizes, optional shadows, and better preview testing for GIFs and 7TV name paints.",
  },
  {
    type: "update",
    date: "2026-09-05",
    title: "Choose your chat platforms",
    summary:
      "Use Twitch, Kick or YouTube on its own, or combine any of them in one overlay.",
  },
  {
    type: "update",
    date: "2026-09-05",
    title: "Optional Twitch GIFs",
    summary:
      "Show native Twitch chat GIFs in your overlay with Show GIFs. Off by default.",
  },
  {
    type: "update",
    date: "2026-09-05",
    title: "YouTube reliability improvements",
    summary:
      "YouTube stream discovery, retries and old chat handling are now much more reliable.",
  },
  {
    type: "incident",
    date: "2026-09-05",
    title: "YouTube discovery issue resolved",
    summary:
      "A problem that could cause excessive YouTube stream checks has been fixed.",
    active: false,
  },
  {
    type: "update",
    date: "2026-08-28",
    title: "Inter font added",
    summary: "Inter is now available as an overlay font.",
  },
  {
    type: "update",
    date: "2026-08-11",
    title: "Platform badges added",
    summary:
      "Twitch, Kick and YouTube messages can now show which platform they came from.",
  },
  {
    type: "update",
    date: "2026-08-07",
    title: "YouTube chat added",
    summary: "jChat+ now supports YouTube Live Chat alongside Twitch and Kick.",
  },
  {
    type: "update",
    date: "2026-06-30",
    title: "jChat+ 1.0 released",
    summary:
      "The first stable version of jChat+ launched with Twitch and Kick support, modern emotes, badges and customization.",
  },
];

(function () {
  var months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  function textElement(tag, text, className) {
    var element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function updateCard(entry, heading) {
    var card = document.createElement("article");
    card.className = "update-card";

    var meta = document.createElement("div");
    meta.className = "update-meta";
    // Format the calendar date directly so time zones cannot shift the day.
    var parts = entry.date.split("-");
    var date = textElement(
      "time",
      Number(parts[2]) + " " + months[Number(parts[1]) - 1] + " " + parts[0],
    );
    date.setAttribute("datetime", entry.date);
    meta.appendChild(date);

    if (entry.type === "incident") {
      var active = entry.active === true;
      meta.appendChild(
        textElement(
          "span",
          active ? "Active" : "Resolved",
          "update-status status-" + (active ? "active" : "resolved"),
        ),
      );
    }

    card.appendChild(meta);
    card.appendChild(textElement(heading, entry.title));
    card.appendChild(textElement("p", entry.summary));
    return card;
  }

  function renderUpdates() {
    var entries = window.JCHAT_UPDATES.slice().sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
    var incidents = entries.filter(function (entry) {
      return entry.type === "incident" && entry.active === true;
    });
    var updates = entries
      .filter(function (entry) {
        return entry.type === "update";
      })
      .slice(0, 3);

    var notices = document.getElementById("site-incidents");
    if (notices) {
      notices.textContent = "";
      incidents.forEach(function (entry) {
        var notice = document.createElement("article");
        notice.className = "incident-notice";
        notice.appendChild(textElement("h2", entry.title));
        notice.appendChild(textElement("p", entry.summary));
        var link = textElement("a", "View updates");
        link.setAttribute("href", "/updates/");
        notice.appendChild(link);
        notices.appendChild(notice);
      });
      notices.hidden = incidents.length === 0;
    }

    var recent = document.getElementById("recent-updates");
    if (recent) {
      recent.textContent = "";
      updates.forEach(function (entry) {
        recent.appendChild(updateCard(entry, "h3"));
      });
    }
    var whatsNew = document.getElementById("whats-new");
    if (whatsNew) whatsNew.hidden = updates.length === 0;

    var all = document.getElementById("all-updates");
    if (all) {
      all.textContent = "";
      entries.forEach(function (entry) {
        all.appendChild(updateCard(entry, "h2"));
      });
    }
    var empty = document.getElementById("updates-empty");
    if (empty) empty.hidden = entries.length !== 0;
  }

  window.JCHAT_RENDER_UPDATES = renderUpdates;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderUpdates);
  } else {
    renderUpdates();
  }
})();
