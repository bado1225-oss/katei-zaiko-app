// Firebase 連携 (家族同期). type="module"で読込。window.kateiSync を公開。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot,
  query, orderBy, limit, getDocs, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyBIyiPCvWsJX60dbCre874DevUviUpBEaA",
  authDomain: "katei-app-c8c01.firebaseapp.com",
  projectId: "katei-app-c8c01",
  storageBucket: "katei-app-c8c01.firebasestorage.app",
  messagingSenderId: "918296200182",
  appId: "1:918296200182:web:b5bace3dc7f0cead893dd7",
};

const HOUSEHOLD = 'main';
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const itemsCol = collection(db, 'households', HOUSEHOLD, 'items');
const logsCol  = collection(db, 'households', HOUSEHOLD, 'logs');

let currentUser = null;
let unsubItems = null;
let unsubLogs = null;
let suppressBroadcast = false;

function fire(name, detail){
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  fire('katei-auth-change', { user });

  if (unsubItems){ unsubItems(); unsubItems = null; }
  if (unsubLogs){  unsubLogs();  unsubLogs  = null; }

  if (!user) return;

  unsubItems = onSnapshot(itemsCol, (snap) => {
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    fire('katei-items-change', { items });
  }, err => fire('katei-sync-error', { kind: 'items', message: err.message }));

  unsubLogs = onSnapshot(
    query(logsCol, orderBy('at','desc'), limit(200)),
    (snap) => {
      const logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      fire('katei-logs-change', { logs });
    },
    err => fire('katei-sync-error', { kind: 'logs', message: err.message })
  );
});

async function pushAll({ items, logs }){
  if (!currentUser) return;
  const batch = writeBatch(db);
  for (const it of items) batch.set(doc(itemsCol, it.id), stripUndef(it));
  for (const lg of logs)  batch.set(doc(logsCol,  lg.id), stripUndef(lg));
  await batch.commit();
}

function stripUndef(o){
  const r = {};
  for (const k in o) if (o[k] !== undefined) r[k] = o[k];
  return r;
}

window.kateiSync = {
  isConnected: () => !!currentUser,
  getUser: () => currentUser,
  signIn: (email, password) => signInWithEmailAndPassword(auth, email, password),
  signOut: () => signOut(auth),
  upsertItem: async (item) => {
    if (!currentUser) return;
    await setDoc(doc(itemsCol, item.id), stripUndef(item));
  },
  deleteItem: async (id) => {
    if (!currentUser) return;
    await deleteDoc(doc(itemsCol, id));
  },
  addLog: async (log) => {
    if (!currentUser) return;
    await setDoc(doc(logsCol, log.id), stripUndef(log));
  },
  clearAll: async () => {
    if (!currentUser) return;
    const batch = writeBatch(db);
    const a = await getDocs(itemsCol);
    a.forEach(d => batch.delete(d.ref));
    const b = await getDocs(logsCol);
    b.forEach(d => batch.delete(d.ref));
    await batch.commit();
  },
  pushAll,
};

fire('katei-sync-ready', { user: currentUser });
