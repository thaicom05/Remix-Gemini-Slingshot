# Security Specification & Test-Driven Development (TDD) for Firestore

## 1. Data Invariants
*   **User Profiles (`/users/{userId}`)**:
    *   A profile can only be created or modified by its respective owner (`request.auth.uid == userId`).
    *   The `highScore` must be a non-negative integer.
    *   The `displayName` must be a non-empty string and maximum 50 characters.
    *   `createdAt` is immutable and must equal the server-side timestamp (`request.time`) upon creation.
*   **Leaderboard Entries (`/leaderboard/{entryId}`)**:
    *   Entries can be read by anyone (public or authenticated players) to display the global leaderboards.
    *   Entries can only be created by signed-in users.
    *   `userId` in the payload must strictly match `request.auth.uid`.
    *   `score` must be a positive integer.
    *   `timestamp` must match `request.time`.
    *   Entries are immutable once created (no update, no delete) to prevent tamper-hacks.

---

## 2. The "Dirty Dozen" Malicious Payloads
The following 12 payloads are designed to attack the system and must be rejected (`PERMISSION_DENIED`):

### Attack 1: User Profile Spoofing (Identity Spoofing)
*   **Target**: `/users/legit_user_abc`
*   **User**: `attacker_123`
*   **Payload**: `{ "displayName": "Attacker", "highScore": 9999, "createdAt": "request.time" }`
*   **Expectation**: Rejected because `request.auth.uid` (`attacker_123`) does not match the document ID (`legit_user_abc`).

### Attack 2: Non-String Name Injection (Type Safety)
*   **Target**: `/users/attacker_123`
*   **User**: `attacker_123`
*   **Payload**: `{ "displayName": 12345, "highScore": 500, "createdAt": "request.time" }`
*   **Expectation**: Rejected because `displayName` is an integer, not a string.

### Attack 3: Negative High Score (Boundary Value)
*   **Target**: `/users/attacker_123`
*   **User**: `attacker_123`
*   **Payload**: `{ "displayName": "Bob", "highScore": -100, "createdAt": "request.time" }`
*   **Expectation**: Rejected because `highScore` must be >= 0.

### Attack 4: Self-Escalation/Ghost Field Injection (Privilege Escalation)
*   **Target**: `/users/attacker_123`
*   **User**: `attacker_123`
*   **Payload**: `{ "displayName": "Bob", "highScore": 10, "createdAt": "request.time", "isAdmin": true }`
*   **Expectation**: Rejected because `isAdmin` is a ghost field not allowed by the strict schema keys validation.

### Attack 5: Client-provided Created Timestamp (Temporal Integrity)
*   **Target**: `/users/attacker_123`
*   **User**: `attacker_123`
*   **Payload**: `{ "displayName": "Bob", "highScore": 10, "createdAt": "2030-01-01T00:00:00Z" }`
*   **Expectation**: Rejected because `createdAt` must match `request.time` exactly.

### Attack 6: Leaderboard Spoofing (Identity Spoofing)
*   **Target**: `/leaderboard/entry_999`
*   **User**: `attacker_123`
*   **Payload**: `{ "userId": "legit_user_abc", "displayName": "Fake Legit", "score": 10000, "timestamp": "request.time" }`
*   **Expectation**: Rejected because `userId` in payload does not match `request.auth.uid` (`attacker_123`).

### Attack 7: Leaderboard Negative Score (Boundary Value)
*   **Target**: `/leaderboard/entry_999`
*   **User**: `attacker_123`
*   **Payload**: `{ "userId": "attacker_123", "displayName": "Attacker", "score": -50, "timestamp": "request.time" }`
*   **Expectation**: Rejected because `score` must be > 0.

### Attack 8: Leaderboard Wallet Exhaustion / Payload Bloat (PII Blanket / Resource Poisoning)
*   **Target**: `/leaderboard/entry_999`
*   **User**: `attacker_123`
*   **Payload**: `{ "userId": "attacker_123", "displayName": "[A 1MB giant string...]", "score": 500, "timestamp": "request.time" }`
*   **Expectation**: Rejected because `displayName` size exceeds the maximum limit (50 characters).

### Attack 9: Mutating Someone Else's Profile (Access Control)
*   **Target**: `/users/legit_user_abc` (Update operation)
*   **User**: `attacker_123`
*   **Payload**: `{ "displayName": "Hacked" }`
*   **Expectation**: Rejected because non-owner cannot write.

### Attack 10: Client-provided Leaderboard Timestamp (Temporal Integrity)
*   **Target**: `/leaderboard/entry_999`
*   **User**: `attacker_123`
*   **Payload**: `{ "userId": "attacker_123", "displayName": "Attacker", "score": 250, "timestamp": "2020-01-01T00:00:00Z" }`
*   **Expectation**: Rejected because `timestamp` must be `request.time` server timestamp.

### Attack 11: Attempting to Delete High Score entries (Data Deletion/Immutability)
*   **Target**: `/leaderboard/entry_999` (Delete operation)
*   **User**: `attacker_123`
*   **Expectation**: Rejected because delete operations on leaderboard are forbidden for standard users.

### Attack 12: Blanket List Read of User Profiles (PII isolation)
*   **Target**: `/users` (List operation without checking specific owner)
*   **User**: `attacker_123`
*   **Expectation**: Rejected because users cannot perform blanket queries across the entire `/users` collection without filtering by their own UID.

---

## 3. Mock Test Runner

Below is `firestore.rules.test.ts` illustrating these assertions in code:

```typescript
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';

describe('Firestore Security Rules', () => {
  let testEnv: any;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'ai-studio-applet-webapp-2172f',
      firestore: {
        host: 'localhost',
        port: 8080,
      }
    });
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it('blocks Attack 1 (User profile spoofing)', async () => {
    const context = testEnv.authenticatedContext('attacker_123');
    const db = context.firestore();
    const docRef = db.collection('users').doc('legit_user_abc');
    await assertFails(docRef.set({
      displayName: 'Attacker',
      highScore: 9999,
      createdAt: new Date()
    }));
  });

  it('blocks Attack 6 (Leaderboard identity spoofing)', async () => {
    const context = testEnv.authenticatedContext('attacker_123');
    const db = context.firestore();
    const docRef = db.collection('leaderboard').doc('entry_999');
    await assertFails(docRef.set({
      userId: 'legit_user_abc',
      displayName: 'Fake Legit',
      score: 10000,
      timestamp: new Date()
    }));
  });
});
```
