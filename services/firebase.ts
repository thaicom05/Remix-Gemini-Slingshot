import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut, 
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc,
  collection, 
  query, 
  orderBy, 
  limit, 
  onSnapshot,
  getDocFromServer,
  Timestamp,
  serverTimestamp
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId); /* CRITICAL: The app will break without this line */
export const auth = getAuth(app);

// Authentication Provider
const googleProvider = new GoogleAuthProvider();

// Error Handling Structures
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Ensure database connection works
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();

// --- Authentication Functions ---

export async function signInWithGoogle(): Promise<User> {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error("Authentication Error during Google Login:", error);
    throw error;
  }
}

export async function logoutUser(): Promise<void> {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Authentication Error during Sign Out:", error);
    throw error;
  }
}

// --- Firestore Operations with Standard Schema validations ---

export interface UserProfileData {
  displayName: string;
  highScore: number;
  createdAt?: any;
}

export interface LeaderboardEntryData {
  id?: string;
  userId: string;
  displayName: string;
  score: number;
  timestamp: any;
}

/**
 * Fetch a player's profile by their UID.
 */
export async function getUserProfile(userId: string): Promise<UserProfileData | null> {
  const path = `users/${userId}`;
  try {
    const docRef = doc(db, 'users', userId);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return docSnap.data() as UserProfileData;
    }
    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return null;
  }
}

/**
 * Create or initialize a user profile.
 */
export async function createUserProfile(userId: string, displayName: string): Promise<void> {
  const path = `users/${userId}`;
  try {
    const docRef = doc(db, 'users', userId);
    const initialData: UserProfileData = {
      displayName,
      highScore: 0,
      createdAt: serverTimestamp()
    };
    await setDoc(docRef, initialData);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

/**
 * Update user's score if it's a new high score.
 */
export async function updateHighScore(userId: string, currentHighScore: number, newScore: number): Promise<void> {
  if (newScore <= currentHighScore) return;
  const path = `users/${userId}`;
  try {
    const docRef = doc(db, 'users', userId);
    await updateDoc(docRef, {
      highScore: newScore
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

/**
 * Save score to the global leaderboard.
 */
export async function submitScoreToLeaderboard(userId: string, displayName: string, score: number): Promise<void> {
  // Generate unique entry ID
  const entryId = `${userId}_${Date.now()}`;
  const path = `leaderboard/${entryId}`;
  try {
    const docRef = doc(db, 'leaderboard', entryId);
    const entryPayload: LeaderboardEntryData = {
      userId,
      displayName,
      score,
      timestamp: serverTimestamp()
    };
    await setDoc(docRef, entryPayload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

/**
 * Real-time high-scores leaderboard subscription.
 */
export function subscribeToLeaderboard(onUpdate: (entries: LeaderboardEntryData[]) => void, onError: (err: any) => void) {
  const path = 'leaderboard';
  const leaderboardRef = collection(db, 'leaderboard');
  const q = query(leaderboardRef, orderBy('score', 'desc'), limit(10));
  
  return onSnapshot(q, (snapshot) => {
    const entries: LeaderboardEntryData[] = [];
    snapshot.forEach((doc) => {
      entries.push({ id: doc.id, ...doc.data() } as LeaderboardEntryData);
    });
    onUpdate(entries);
  }, (error) => {
    try {
      handleFirestoreError(error, OperationType.LIST, path);
    } catch (e) {
      onError(e);
    }
  });
}
