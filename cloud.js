(() => {
  const sdk = 'https://www.gstatic.com/firebasejs/12.6.0/';
  const config = {
    apiKey: 'AIzaSyDsVKQLDYX9X1tj1y6eJM4PzazaBML5__0',
    authDomain: 'wortschatz-e7547.firebaseapp.com',
    projectId: 'wortschatz-e7547',
    appId: '1:350411891441:web:3213b66662282189cd3f50'
  };
  const empty = () => ({ records: {}, pending: {} });
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const newer = (a, b) => !b || a.at > b.at || (a.at === b.at && a.tie > b.tie);
  // Seed records from a pre-login device only when a card is absent in the cloud.
  const validRecord = ([id, value]) => value && value.length <= 24000 &&
    id.length <= 450 && encodeURIComponent(id).length < 1500 && /^[pw]:.+$/.test(id);
  const stamp = (value, seed) => ({ at: seed ? 0 : Date.now(), tie: crypto.randomUUID(), value });
  const states = uid => 'cloud-state:' + uid;
  const seeds = uid => 'cloud-seed:' + uid;
  const ownerKey = 'cloud-account';
  function readUpdate(store, key, update) {
    const read = store.get(key);
    read.onsuccess = () => store.put(update(read.result), key);
  }

  function create({ get, change, onAccount, onRecords, onStatus, guestRecords }) {
    let api, auth, firestore, loading, account, stop, retryTimer;
    let busy = false, onlineSnapshot = false, failedSnapshot = null, writeError = null;
    let model = empty(), queue = Promise.resolve();
    const awaitingLocal = new Map();
    const announce = (text, error = false) => onStatus({
      text, error, connected: Boolean(api), account, pending: Object.keys(model.pending).length > 0
    });
    const enqueue = task => {
      const run = queue.then(task);
      queue = run.catch(() => {});
      return run;
    };
    const setModel = next => {
      model = next;
      const staged = awaitingLocal.get(account?.uid);
      onRecords(staged?.size ? { ...next.records, ...Object.fromEntries(staged) } : next.records);
    };
    const syncStatus = () => {
      const error = failedSnapshot || writeError;
      if (error && navigator.onLine) return announce(errorText(error), true);
      if (Object.keys(model.pending).length) return announce(navigator.onLine ? 'Синхронизация…' : 'Изменения ждут подключения');
      announce(onlineSnapshot && navigator.onLine ? 'Синхронизировано' : 'Ожидаем подключения к облаку');
    };
    function errorText(error) {
      return ({
        'auth/unauthorized-domain': 'Добавь домен приложения в разрешённые домены Firebase.',
        'auth/operation-not-allowed': 'Включи способ входа Google в Firebase Authentication.',
        'auth/popup-blocked': 'Окно Google заблокировано. Разреши всплывающие окна для Wortschatz и попробуй снова.',
        'auth/popup-closed-by-user': 'Окно Google было закрыто. Можно повторить вход.',
        'auth/web-storage-unsupported': 'В этом режиме браузера вход недоступен. Проверь настройки хранения данных сайта.',
        'auth/network-request-failed': 'Подключись к интернету и повтори вход.',
        'permission-denied': 'Firestore не разрешил синхронизацию. Проверь опубликованные правила.',
        'not-found': 'Создай базу Firestore в проекте Wortschatz.'
      })[error?.code] || 'Не удалось связаться с облаком. Изменения остаются на устройстве.';
    }

    function saveLocal(values, expectedUid = account?.uid) {
      const entries = Object.entries(values);
      if (!entries.every(validRecord)) {
        announce('Не удалось синхронизировать слишком большую карточку.', true);
        return Promise.reject(Error('Invalid cloud record'));
      }
      if (!expectedUid) return Promise.reject(Error('No active account'));
      const batch = entries.map(([id, value]) => [id, stamp(value, false)]);
      const staged = awaitingLocal.get(expectedUid) || new Map();
      awaitingLocal.set(expectedUid, staged);
      for (const [id, entry] of batch) staged.set(id, entry);
      const release = () => {
        for (const [id, entry] of batch) if (staged.get(id) === entry) staged.delete(id);
        if (!staged.size) awaitingLocal.delete(expectedUid);
      };
      return enqueue(async () => {
        let next;
        await change(store => readUpdate(store, states(expectedUid), existing => {
          next = existing || empty();
          for (const [id, entry] of batch) {
            const previous = next.records[id];
            if (previous && !newer(entry, previous)) entry.at = previous.at + 1;
            next.records[id] = next.pending[id] = entry;
          }
          return next;
        }));
        release();
        if (account?.uid === expectedUid) {
          setModel(next);
          syncStatus();
          schedule();
        }
      }).catch(error => {
        release();
        announce('Не удалось сохранить изменения на устройстве.', true);
        throw error;
      });
    }

    async function receive(uid, incoming, sent = {}) {
      return enqueue(async () => {
        let next;
        await change(store => readUpdate(store, states(uid), existing => {
          next = existing || empty();
          for (const [id, entry] of Object.entries(incoming)) {
            if (newer(entry, next.records[id])) next.records[id] = entry;
          }
          for (const [id, entry] of Object.entries(sent)) {
            if (next.pending[id]?.tie !== entry.tie) continue;
            // Another device may already have an entry for a seeded card.
            if (next.records[id]?.tie === entry.tie && own(incoming, id)) next.records[id] = incoming[id];
            delete next.pending[id];
          }
          return next;
        }));
        if (account?.uid === uid) {
          setModel(next);
          syncStatus();
        }
      });
    }

    function collection(uid) {
      return api.collection(firestore, 'wortschatzAccounts', uid, 'entries');
    }

    function schedule(ms = 350) {
      if (!retryTimer && account && auth?.currentUser?.uid === account.uid && navigator.onLine) {
        retryTimer = setTimeout(() => { retryTimer = null; flush(); }, ms);
      }
    }

    async function flush() {
      if (busy || !account || auth?.currentUser?.uid !== account.uid) return;
      const uid = account.uid;
      const sent = Object.fromEntries(Object.entries(model.pending).slice(0, 75));
      if (!Object.keys(sent).length) return;
      busy = true;
      let retry = 350;
      try {
        const received = await api.runTransaction(firestore, async transaction => {
          const rows = await Promise.all(Object.entries(sent).map(async ([id, entry]) => {
            const ref = api.doc(collection(uid), encodeURIComponent(id));
            return { id, entry, ref, snapshot: await transaction.get(ref) };
          }));
          const result = {};
          for (const { id, entry, ref, snapshot } of rows) {
            const remote = snapshot.data();
            if (!remote || (entry.at > 0 && newer(entry, remote))) {
              transaction.set(ref, { ...entry, id });
              result[id] = entry;
            } else {
              result[id] = remote;
            }
          }
          return result;
        });
        if (account?.uid === uid) writeError = null;
        await receive(uid, received, sent);
      } catch (error) {
        if (account?.uid === uid) { writeError = error; syncStatus(); }
        retry = 10000;
      } finally {
        busy = false;
        if (Object.keys(model.pending).length) schedule(retry);
      }
    }

    function listen(uid) {
      stop?.();
      stop = api.onSnapshot(collection(uid), { includeMetadataChanges: true }, snapshot => {
        if (account?.uid !== uid || snapshot.metadata.fromCache) return;
        const docs = onlineSnapshot ? snapshot.docChanges().filter(item => item.type !== 'removed').map(item => item.doc) : snapshot.docs;
        onlineSnapshot = true;
        failedSnapshot = null;
        if (!docs.length) syncStatus();
        const rows = Object.fromEntries(docs.map(doc => {
          const { id, at, tie, value } = doc.data();
          return [id, { at, tie, value }];
        }));
        if (docs.length) receive(uid, rows).catch(error => announce(errorText(error), true));
        if (Object.keys(model.pending).length) schedule();
      }, error => {
        if (account?.uid === uid) {
          failedSnapshot = error;
          syncStatus();
        }
      });
    }

    async function activate(user) {
      return enqueue(async () => {
        stop?.();
        stop = null;
        onlineSnapshot = false;
        failedSnapshot = null;
        writeError = null;
        if (!user) {
          await change(store => store.delete(ownerKey));
          account = null;
          model = empty();
          await onAccount(null);
          announce('Войди, чтобы синхронизировать прогресс и свои слова.');
          return;
        }
        const uid = user.uid;
        const candidate = await guestRecords();
        const previouslyAsked = await get(seeds(uid));
        const seed = !previouslyAsked && Object.keys(candidate).length &&
          confirm('Добавить прогресс и свои слова с этого устройства в Google-аккаунт? Для совпадающих карточек сохранится облачный прогресс.');
        const profile = { uid, email: user.email || '' };
        let next;
        await change(store => {
          store.put(profile, ownerKey);
          store.put(true, seeds(uid));
          readUpdate(store, states(uid), previous => {
            next = previous || empty();
            if (seed) for (const [id, value] of Object.entries(candidate).filter(validRecord)) {
              if (!own(next.records, id)) next.records[id] = next.pending[id] = stamp(value, true);
            }
            return next;
          });
        });
        account = profile;
        await onAccount(profile);
        setModel(next);
        listen(uid);
        schedule();
        syncStatus();
      });
    }

    function connect() {
      if (loading) return loading;
      loading = Promise.all([
        import(sdk + 'firebase-app.js'), import(sdk + 'firebase-auth.js'),
        import(sdk + 'firebase-firestore.js')
      ]).then(([app, authApi, db]) => {
        const appInstance = app.initializeApp(config);
        auth = authApi.getAuth(appInstance);
        firestore = db.getFirestore(appInstance);
        api = { ...authApi, ...db };
        authApi.onAuthStateChanged(auth, user => activate(user).catch(error => announce(errorText(error), true)));
        announce(account ? 'Подключаемся к облаку…' : 'Войди, чтобы синхронизировать прогресс и свои слова.');
      }).catch(() => {
        loading = null;
        announce('Вход через Google недоступен. Проверь подключение к интернету.', true);
      });
      return loading;
    }

    addEventListener('online', () => { connect(); schedule(); });
    addEventListener('offline', () => {
      clearTimeout(retryTimer);
      retryTimer = null;
      if (account) syncStatus();
    });
    addEventListener('pageshow', () => { if (account) schedule(); });
    return {
      async restore() {
        account = await get(ownerKey);
        if (account) {
          await onAccount(account);
          setModel(await get(states(account.uid)) || empty());
          syncStatus();
        }
        connect();
      },
      saveLocal,
      login() {
        if (!api) { connect(); return; }
        announce('Открываем вход через Google…');
        api.signInWithPopup(auth, new api.GoogleAuthProvider()).catch(error => announce(errorText(error), true));
      },
      async logout() {
        if (!api) return;
        try {
          await api.signOut(auth);
        } catch (error) { announce(errorText(error), true); }
      }
    };
  }
  window.WortschatzCloud = { create };
})();
