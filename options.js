document.addEventListener('DOMContentLoaded', async () => {
  const settings = await browser.storage.local.get({
    pushoverUserKey: '',
    pushoverAppToken: '',
    enableNotifications: true,
    selectedAccounts: [],
    filterSender: '',
    filterSubject: '',
    includeBody: false,
    bodyCharLimit: 0,
    notificationPriority: '0',
    notificationSound: '',
    retryInterval: 60,
    expireTime: 3600
  });

  document.getElementById('pushoverUserKey').value = settings.pushoverUserKey;
  document.getElementById('pushoverAppToken').value = settings.pushoverAppToken;
  document.getElementById('enableNotifications').checked = settings.enableNotifications;
  document.getElementById('filterSender').value = settings.filterSender;
  document.getElementById('filterSubject').value = settings.filterSubject;
  document.getElementById('includeBody').checked = settings.includeBody;
  document.getElementById('bodyCharLimit').value = settings.bodyCharLimit;
  document.getElementById('notificationPriority').value = settings.notificationPriority;
  document.getElementById('notificationSound').value = settings.notificationSound;
  document.getElementById('retryInterval').value = settings.retryInterval;
  document.getElementById('expireTime').value = settings.expireTime;

  let accounts = await browser.accounts.list();
  let accountsListDiv = document.getElementById('accounts-list');

  accounts.forEach(account => {
    let checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = account.id;
    checkbox.value = account.id;
    checkbox.checked = settings.selectedAccounts.includes(account.id);

    let label = document.createElement('label');
    label.htmlFor = account.id;
    label.appendChild(document.createTextNode(account.name));

    accountsListDiv.appendChild(checkbox);
    accountsListDiv.appendChild(label);
    accountsListDiv.appendChild(document.createElement('br'));
  });

  document.getElementById('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    let selectedAccounts = Array.from(document.querySelectorAll('#accounts-list input[type="checkbox"]:checked')).map(cb => cb.value);

    await browser.storage.local.set({
      pushoverUserKey: document.getElementById('pushoverUserKey').value,
      pushoverAppToken: document.getElementById('pushoverAppToken').value,
      enableNotifications: document.getElementById('enableNotifications').checked,
      selectedAccounts: selectedAccounts,
      filterSender: document.getElementById('filterSender').value,
      filterSubject: document.getElementById('filterSubject').value,
      includeBody: document.getElementById('includeBody').checked,
      bodyCharLimit: parseInt(document.getElementById('bodyCharLimit').value, 10),
      notificationPriority: document.getElementById('notificationPriority').value,
      notificationSound: document.getElementById('notificationSound').value,
      retryInterval: parseInt(document.getElementById('retryInterval').value, 10),
      expireTime: parseInt(document.getElementById('expireTime').value, 10)
    });

    alert('Settings saved.');
  });
});
