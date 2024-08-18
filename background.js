browser.messages.onNewMailReceived.addListener(async (folder, messageList) => {
  console.log("New mail received");

  const settings = await browser.storage.local.get({
    pushoverUserKey: "",
    pushoverAppToken: "",
    enableNotifications: true,
    selectedAccounts: [],
    filterSender: "",
    filterSubject: "",
    includeBody: false,
    bodyCharLimit: 0,
    notificationPriority: '0',
    notificationSound: '',
    retryInterval: 60,
    expireTime: 3600
  });

  console.log("Settings loaded:", settings);

  if (!settings.enableNotifications || !settings.pushoverUserKey || !settings.pushoverAppToken) {
    console.log("Notifications are disabled or API keys are missing");
    return;
  }

  for (let message of messageList.messages) {
    let accountId = folder.accountId;
    if (!settings.selectedAccounts.includes(accountId)) {
      console.log("Message from an unselected account:", accountId);
      continue;
    }

    let subject = message.subject;
    let from = message.author;

    if (settings.filterSender && !from.includes(settings.filterSender)) {
      console.log("Message filtered out by sender:", from);
      continue;
    }

    if (settings.filterSubject && !subject.includes(settings.filterSubject)) {
      console.log("Message filtered out by subject:", subject);
      continue;
    }

    let bodyText = "";
    if (settings.includeBody) {
      try {
        let fullMessage = await browser.messages.getFull(message.id);
        bodyText = fullMessage.parts.filter(part => part.contentType === "text/plain")[0]?.body || "";

        if (settings.bodyCharLimit > 0 && bodyText.length > settings.bodyCharLimit) {
          bodyText = bodyText.substring(0, settings.bodyCharLimit) + "...";
        }
      } catch (error) {
        console.error("Failed to retrieve the full message body", error);
      }
    }

    const requestBody = new URLSearchParams({
      token: settings.pushoverAppToken,
      user: settings.pushoverUserKey,
      message: `New email from ${from}: ${subject}${settings.includeBody ? "\n\n" + bodyText : ""}`,
      priority: settings.notificationPriority,
      sound: settings.notificationSound
    });

    const retryInterval = Math.max(settings.retryInterval, 30).toString();
    const expireTime = settings.expireTime.toString();

    if (settings.notificationPriority === '2') {
      requestBody.append('retry', retryInterval);
      requestBody.append('expire', expireTime);
    }

    console.log("Sending Pushover notification with body:", requestBody.toString());

    try {
      let response = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        body: requestBody
      });

      if (!response.ok) {
        let responseText = await response.text();
        console.error("Failed to send Pushover notification:", responseText);
      } else {
        console.log("Pushover notification sent successfully");
      }
    } catch (error) {
      console.error("Error sending Pushover notification", error);
    }
  }
});
