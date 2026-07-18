// ============================================================
// FIREBASE CONFIG — استبدل القيم التالية بالقيم من مشروعك في
// Firebase Console → Project Settings → General → Your apps → SDK setup
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDwd3QoT3kdBjoz_O5CqNN3ejQsCc74XCE",
  authDomain: "coop-uqu.firebaseapp.com",
  projectId: "coop-uqu",
  storageBucket: "coop-uqu.firebasestorage.app",
  messagingSenderId: "566631664402",
  appId: "1:566631664402:web:8c4cfdb72b0654ca9041cb"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
