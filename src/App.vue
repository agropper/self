<template>
  <q-layout view="hHh lpR fFf">
    <q-page-container class="full-width">
      <q-page>
        <!-- Not authenticated - show auth dialog -->
        <div v-if="!authenticated" class="flex flex-center" style="height: 100vh">
          <template v-if="deepLinkShareId">
            <q-card style="min-width: 420px; max-width: 520px">
              <q-card-section>
                <div class="text-h6 text-center q-mb-md">Join a Shared MAIA Chat</div>
                <div class="text-body2 text-center q-mb-lg">
                  Enter your name and email to view the shared conversation. We’ll remember you for the next month on this device.
                </div>

                <div v-if="deepLinkLoading" class="text-center q-pa-md">
                  <q-spinner size="2em" />
                  <div class="q-mt-sm">Preparing your invitation...</div>
                </div>

                <div v-else>
                  <div v-if="deepLinkError" class="text-negative text-center q-mb-md">
                    {{ deepLinkError }}
                  </div>

                  <DeepLinkAccess
                    v-if="showDeepLinkAccess && deepLinkShareId"
                    :share-id="deepLinkShareId"
                    @authenticated="handleDeepLinkAuthenticated"
                  />

                  <div v-else class="text-center text-caption text-grey">
                    Awaiting invitation details...
                  </div>
                </div>
              </q-card-section>
            </q-card>
          </template>

          <template v-else>
            <q-card style="width: 95vw; max-width: 95vw; height: 95vh; max-height: 95vh; display: flex; flex-direction: column; overflow: hidden;">
              <q-card-section style="flex: 1; overflow-y: auto; display: flex; flex-direction: column;">
                <div class="text-h6 text-center q-mb-sm">
                  Welcome to MAIA
                </div>
                <div class="text-center q-mb-md">
                  <p class="q-ma-none">Sign in with your passkey or create a new account</p>
                </div>

                <div v-if="!showAuth">
                  <!-- Get Started Button - positioned right after title/subtitle -->
                  <q-btn
                    label="Get Started"
                    color="primary"
                    size="lg"
                    class="full-width q-mb-lg"
                    :loading="tempStartLoading"
                    @click="startTemporarySession"
                  />
                  <div v-if="tempStartError" class="text-negative text-center q-mb-md">
                    {{ tempStartError }}
                  </div>
                  <div class="text-center q-mb-lg">
                    <q-btn
                      flat
                      dense
                      color="primary"
                      label="Use Passkey Instead"
                      @click="() => { passkeyPrefillUserId = null; passkeyPrefillAction = null; showAuth = true; }"
                    />
                  </div>

                  <!-- Video and Caption Section - at bottom, side by side -->
                  <div class="row q-col-gutter-md q-mt-lg">
                    <!-- Smaller Video -->
                    <div class="col-12 col-md-5">
                      <div class="video-container" style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 100%; background: #000; border-radius: 4px;">
                        <video
                          style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain;"
                          controls
                          preload="auto"
                          playsinline
                        >
                          <source src="/MAIA.mp4" type="video/mp4">
                          Your browser does not support the video tag.
                        </video>
                      </div>
                    </div>

                    <!-- Caption to the right of video -->
                    <div class="col-12 col-md-7">
                      <div class="text-body2 text-grey-7 q-pa-md" style="background-color: #f5f5f5; border-radius: 4px; height: 100%; display: flex; align-items: center;">
                        <p class="q-ma-none">
                          {{ welcomeCaption || 'Loading...' }}
                        </p>
                      </div>
                    </div>
                  </div>

                  <!-- Privacy link at bottom -->
                  <div class="text-center q-mt-lg q-mb-md">
                    <a 
                      href="#" 
                      @click.prevent="showPrivacyDialog = true"
                      style="color: #1976d2; text-decoration: none; font-size: 0.9rem; cursor: pointer;"
                      class="text-primary"
                    >
                      Privacy, Security, Communities, and Risk
                    </a>
                  </div>
                </div>

                <PasskeyAuth
                  v-if="showAuth"
                  :prefill-user-id="passkeyPrefillUserId"
                  :prefill-action="passkeyPrefillAction"
                  @authenticated="handleAuthenticated"
                  @cancelled="showAuth = false"
                />
              </q-card-section>
            </q-card>
          </template>
        </div>

        <!-- Authenticated - show main interface or admin page -->
        <div v-else class="full-width full-height">
          <AdminUsers v-if="showAdminPage" />
          <ChatInterface
            v-else
            :user="user"
            :is-deep-link-user="isDeepLinkUser"
            :deep-link-info="deepLinkInfo"
            :restore-chat-state="restoredChatState"
            :rehydration-files="rehydrationFiles"
            :rehydration-active="rehydrationActive"
            :suppress-wizard="suppressWizard"
            @sign-out="handleSignOut"
            @restore-applied="restoredChatState = null"
            @rehydration-complete="handleRehydrationComplete"
            @update:deep-link-info="handleDeepLinkInfoUpdate"
          />
        </div>
      </q-page>
    </q-page-container>
    
    <!-- Privacy Dialog -->
    <PrivacyDialog v-model="showPrivacyDialog" />

    <!-- Passkey dialog for authenticated users -->
    <q-dialog v-model="showPasskeyDialog" persistent>
      <q-card style="min-width: 420px; max-width: 520px">
        <q-card-section>
          <div class="text-h6 text-center q-mb-md">Add a Passkey</div>
        </q-card-section>
        <q-card-section>
          <PasskeyAuth
            :prefill-user-id="passkeyPrefillUserId"
            :prefill-action="passkeyPrefillAction"
            @authenticated="handlePasskeyAuthenticated"
            @cancelled="showPasskeyDialog = false"
          />
        </q-card-section>
      </q-card>
    </q-dialog>

    <!-- Temporary account sign-out confirmation -->
    <q-dialog v-model="showTempSignOutDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Delete Temporary Account?</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            If you sign out, your temporary account as <strong>{{ user?.userId }}</strong> will be deleted and you will need to import any files in your health record when you return under some other pseudonym. Your deep links will no longer respond.
          </p>
          <p class="q-mt-md">
            Click <strong>CANCEL</strong> to return to MAIA and download any Saved Chats you want to keep.
            Click <strong>DELETE MY MAIA</strong> to destroy this account.
          </p>
          <div class="q-mt-md q-pa-md" style="border: 1px solid #e0e0e0; border-radius: 4px;">
            <strong>Note:</strong> You can add a passkey to your account instead of destroying it. You will then be able to sign-out the usual way and sign-in from other computers.
            <div class="q-mt-sm">
              <q-btn
                flat
                dense
                color="primary"
                label="CREATE A PASSKEY"
                @click="startPasskeyRegistration"
              />
            </div>
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="CANCEL" color="primary" @click="showTempSignOutDialog = false" />
          <q-btn flat label="DELETE MY MAIA" color="negative" @click="openDestroyDialog" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Dormant account choice for standard users -->
    <q-dialog v-model="showDormantDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Sign Out Options</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            You have {{ dormantDeepLinkCount }} active deep link{{ dormantDeepLinkCount === 1 ? '' : 's' }}.
            If you go dormant, those links will stop working until you reactivate your account.
          </p>
          <p class="q-mt-md">
            Choose <strong>KEEP SERVER LIVE</strong> to keep your deep links active.
            Choose <strong>GO DORMANT</strong> to save a local backup and delete your knowledge base.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="KEEP SERVER LIVE"
            color="primary"
            :disable="dormantLoading"
            @click="handleLiveSignOut"
          />
          <q-btn
            flat
            label="GO DORMANT"
            color="negative"
            :disable="dormantLoading"
            @click="handleDormantSignOut"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Restore local backup dialog -->
    <q-dialog v-model="showRestoreDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Restore Local Backup?</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            We found a local backup from <strong>{{ restoreSnapshot?.user?.userId }}</strong>.
            This can restore your saved chats and current chat draft to the new temporary account.
          </p>
          <p class="q-mt-md">
            Your files must be re-uploaded if the server was deleted.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="SKIP"
            color="primary"
            :disable="restoreLoading"
            @click="handleSkipRestore"
          />
          <q-btn
            flat
            label="RESTORE"
            color="negative"
            :disable="restoreLoading"
            @click="handleRestoreSnapshot"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Missing agent dialog -->
    <q-dialog v-model="showMissingAgentDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Local Backup Found</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            We found a local backup for <strong>{{ missingAgentUserId }}</strong>, but no matching agent is available.
          </p>
          <p class="q-mt-md">
            Choose what to do with the local backup.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="CLEAR LOCAL STORAGE"
            color="primary"
            @click="handleClearLocalBackup"
          />
          <q-btn
            flat
            label="START THE WIZARD AGAIN"
            color="negative"
            @click="handleStartWizardAgain"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Confirm destroy dialog -->
    <q-dialog v-model="showDestroyDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Temporary Account Removed</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            Your private information has been preserved on your computer and deleted from the cloud host.
            If you return to MAIA at a later time (from the same computer and web browser) you will be offered an opportunity
            to restore your MAIA to its previous state. We do this for privacy and to reduce cloud hosting costs.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            label="OK"
            color="negative"
            :loading="destroyLoading"
            @click="destroyTemporaryAccount"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-layout>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

// Store route check interval and event listener for cleanup (must be at top level)
const routeCheckInterval = ref<ReturnType<typeof setInterval> | null>(null);
const checkRouteRef = ref<(() => void) | null>(null);

// Register cleanup hook at top level (before any async operations)
onUnmounted(() => {
  if (routeCheckInterval.value) {
    clearInterval(routeCheckInterval.value);
    routeCheckInterval.value = null;
  }
  if (checkRouteRef.value) {
    window.removeEventListener('popstate', checkRouteRef.value);
    checkRouteRef.value = null;
  }
});
import PasskeyAuth from './components/PasskeyAuth.vue';
import ChatInterface from './components/ChatInterface.vue';
import DeepLinkAccess from './components/DeepLinkAccess.vue';
import PrivacyDialog from './components/PrivacyDialog.vue';
import AdminUsers from './components/AdminUsers.vue';
import { useQuasar } from 'quasar';
import { saveUserSnapshot, getLastSnapshotUserId, getUserSnapshot, clearLastSnapshotUserId } from './utils/localDb';

interface User {
  userId: string;
  displayName: string;
  isDeepLink?: boolean;
  isTemporary?: boolean;
  isAdmin?: boolean;
  deepLinkInfo?: DeepLinkInfo | null;
}

interface DeepLinkInfo {
  shareId: string | null;
  chatId?: string | null;
}

interface SignOutSnapshot {
  currentChat?: {
    messages: any[];
    uploadedFiles: any[];
    inputMessage: string;
    providerKey: string;
    providerLabel: string;
    savedChatId?: string | null;
    savedChatShareId?: string | null;
  };
}

const DEFAULT_TITLE = 'MAIA User App';

const authenticated = ref(false);
const showAuth = ref(false);
const user = ref<User | null>(null);
const isDeepLinkUser = ref(false);
const deepLinkInfo = ref<DeepLinkInfo | null>(null);
const deepLinkShareId = ref<string | null>(null);
const showDeepLinkAccess = ref(false);
const deepLinkLoading = ref(false);
const deepLinkError = ref('');
const showPrivacyDialog = ref(false);
const showAdminPage = ref(false);
const welcomeCaption = ref<string>('');
const tempStartLoading = ref(false);
const tempStartError = ref('');
const showTempSignOutDialog = ref(false);
const showDestroyDialog = ref(false);
const destroyConfirm = ref('');
const destroyLoading = ref(false);
const passkeyPrefillUserId = ref<string | null>(null);
const passkeyPrefillAction = ref<'signin' | 'register' | null>(null);
const showPasskeyDialog = ref(false);
const showDormantDialog = ref(false);
const dormantDeepLinkCount = ref(0);
const dormantLoading = ref(false);
const signOutSnapshot = ref<SignOutSnapshot | null>(null);
const showRestoreDialog = ref(false);
const restoreLoading = ref(false);
const restoreSnapshot = ref<any | null>(null);
const restoredChatState = ref<any | null>(null);
const rehydrationFiles = ref<any[]>([]);
const rehydrationActive = ref(false);
const suppressWizard = ref(false);
const showMissingAgentDialog = ref(false);
const missingAgentUserId = ref<string | null>(null);
const pendingLocalUserId = ref<string | null>(null);

const $q = useQuasar();

const setAuthenticatedUser = (userData: any, deepLink: DeepLinkInfo | null = null) => {
  if (!userData) return;
  const normalizedUser: User = {
    userId: userData.userId,
    displayName: userData.displayName || userData.userId,
    isDeepLink: !!userData.isDeepLink,
    isTemporary: !!userData.isTemporary,
    isAdmin: !!userData.isAdmin,
    deepLinkInfo: userData.deepLinkInfo || null
  };

  user.value = normalizedUser;
  authenticated.value = true;
  showAuth.value = false;
  isDeepLinkUser.value = !!normalizedUser.isDeepLink;

  // Update window title to include user ID
  if (typeof document !== 'undefined') {
    document.title = `MAIA for ${normalizedUser.userId}`;
  }

  // Check if user is on /admin but is not an admin - redirect to root
  if (typeof window !== 'undefined') {
    const isAdminPage = window.location.pathname === '/admin';
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    // In production (non-localhost), redirect away from /admin after authentication
    // This prevents new users from seeing the admin page after registration
    // The backend will enforce admin access if they try to access admin routes
    if (isAdminPage && !isLocalhost && !normalizedUser.isAdmin) {
      // Redirect to root - backend will enforce admin access if needed
      window.history.replaceState({}, '', '/');
      showAdminPage.value = false;
    }
  }

  if (isDeepLinkUser.value) {
    const sessionInfo = userData.deepLinkInfo || {};
    const resolvedShareId = (deepLink && deepLink.shareId) || sessionInfo.activeShareId || deepLinkShareId.value || (Array.isArray(sessionInfo.shareIds) ? sessionInfo.shareIds[0] : null) || null;
    const resolvedChatId = (deepLink && deepLink.chatId) || sessionInfo.chatId || null;
    if (resolvedShareId) {
      deepLinkShareId.value = resolvedShareId;
    }
    deepLinkInfo.value = {
      shareId: resolvedShareId,
      chatId: resolvedChatId
    };
    showDeepLinkAccess.value = false;
  } else {
    deepLinkInfo.value = deepLink;
  }
};

const handleAuthenticated = (userData: any) => {
  const pendingDeepLink =
    deepLinkShareId.value
      ? { shareId: deepLinkShareId.value, chatId: null }
      : null;
  setAuthenticatedUser(userData, pendingDeepLink);
  
  // After authentication, if on /admin path (and not localhost), redirect to root
  // This fixes the issue where new users end up on /admin after registration
  if (typeof window !== 'undefined') {
    const isAdminPage = window.location.pathname === '/admin';
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    if (isAdminPage && !isLocalhost && !userData?.isAdmin) {
      // Redirect to root after a brief delay to ensure state is updated
      setTimeout(() => {
        window.location.href = '/';
      }, 100);
    }
  }
};

const handleDeepLinkAuthenticated = (payload: { user: User; deepLinkInfo: DeepLinkInfo }) => {
  setAuthenticatedUser({ ...payload.user, isDeepLink: true, deepLinkInfo: payload.deepLinkInfo }, payload.deepLinkInfo);
  showDeepLinkAccess.value = false;
  deepLinkLoading.value = false;
  deepLinkError.value = '';
};

const handlePasskeyAuthenticated = (userData: any) => {
  showPasskeyDialog.value = false;
  handleAuthenticated(userData);
};

const resetAuthState = () => {
  authenticated.value = false;
  user.value = null;
  isDeepLinkUser.value = false;
  deepLinkInfo.value = null;
  showAuth.value = false;
  passkeyPrefillUserId.value = null;
  passkeyPrefillAction.value = null;
  showPasskeyDialog.value = false;
  showDeepLinkAccess.value = !!deepLinkShareId.value;

  if (typeof document !== 'undefined') {
    document.title = DEFAULT_TITLE;
  }
};

const saveLocalSnapshot = async (snapshot?: SignOutSnapshot | null) => {
  if (!user.value?.userId || user.value.isDeepLink) return;
  try {
    const [filesResponse, chatsResponse, statusResponse, summaryResponse] = await Promise.all([
      fetch(`/api/user-files?userId=${encodeURIComponent(user.value.userId)}`, {
        credentials: 'include'
      }),
      fetch(`/api/user-chats?userId=${encodeURIComponent(user.value.userId)}`, {
        credentials: 'include'
      }),
      fetch(`/api/user-status?userId=${encodeURIComponent(user.value.userId)}`, {
        credentials: 'include'
      }),
      fetch(`/api/patient-summary?userId=${encodeURIComponent(user.value.userId)}`, {
        credentials: 'include'
      })
    ]);

    const files = filesResponse.ok ? await filesResponse.json() : null;
    const savedChats = chatsResponse.ok ? await chatsResponse.json() : null;
    const status = statusResponse.ok ? await statusResponse.json() : null;
    const summary = summaryResponse.ok ? await summaryResponse.json() : null;
    const filesList = Array.isArray(files?.files) ? files.files : [];
    const indexedSet = new Set(Array.isArray(files?.indexedFiles) ? files.indexedFiles : []);
    const kbName = files?.kbName || null;
    const fileStatusSummary = filesList.map((file: any) => {
      const bucketKey = file.bucketKey || '';
      const inKnowledgeBase = kbName && Array.isArray(file.knowledgeBases)
        ? file.knowledgeBases.includes(kbName)
        : false;
      let chipStatus: 'indexed' | 'pending' | 'not_in_kb' = 'not_in_kb';
      if (inKnowledgeBase && indexedSet.has(bucketKey)) {
        chipStatus = 'indexed';
      } else if (inKnowledgeBase && !indexedSet.has(bucketKey)) {
        chipStatus = 'pending';
      }
      return {
        fileName: file.fileName,
        bucketKey,
        chipStatus
      };
    });

    if (fileStatusSummary.length > 0) {
      console.log(`[LOCAL] Saved Files snapshot for ${user.value.userId}:`);
      fileStatusSummary.forEach(entry => {
        console.log(`[LOCAL]  • ${entry.fileName || entry.bucketKey} (${entry.chipStatus})`);
      });
    } else {
      console.log(`[LOCAL] Saved Files snapshot for ${user.value.userId}: none`);
    }

    await saveUserSnapshot({
      user: {
        userId: user.value.userId,
        displayName: user.value.displayName,
        isTemporary: user.value.isTemporary,
        isAdmin: user.value.isAdmin
      },
      files,
      savedChats,
      currentChat: snapshot?.currentChat || null,
      currentMedications: status?.currentMedications || null,
      initialFile: status?.initialFile || null,
      fileStatusSummary,
      patientSummary: summary?.summary || null
    });
  } catch (error) {
    console.warn('Failed to save local snapshot:', error);
  }
};

const performSignOut = async () => {
  const response = await fetch('/api/sign-out', {
    method: 'POST',
    credentials: 'include'
  });

  if (response.ok) {
    resetAuthState();
    if (deepLinkShareId.value) {
      await checkDeepLinkSession(deepLinkShareId.value);
    }
  }
};

const handleDormantSignOut = async () => {
  if (!user.value?.userId) return;
  dormantLoading.value = true;
  try {
    await saveLocalSnapshot(signOutSnapshot.value);
    await fetch('/api/account/dormant', {
      method: 'POST',
      credentials: 'include'
    });
    await performSignOut();
  } catch (error) {
    console.error('Dormant sign out error:', error);
  } finally {
    dormantLoading.value = false;
    showDormantDialog.value = false;
    signOutSnapshot.value = null;
  }
};

const handleLiveSignOut = async () => {
  dormantLoading.value = true;
  try {
    await saveLocalSnapshot(signOutSnapshot.value);
    await performSignOut();
  } catch (error) {
    console.error('Sign out error:', error);
  } finally {
    dormantLoading.value = false;
    showDormantDialog.value = false;
    signOutSnapshot.value = null;
  }
};

const clearWizardPendingKey = (userId?: string | null) => {
  const key = userId ? `wizardKbPendingFileName-${userId}` : 'wizardKbPendingFileName';
  try {
    localStorage.removeItem(key);
  } catch (error) {
    // ignore
  }
};

const handleClearLocalBackup = () => {
  if (pendingLocalUserId.value) {
    console.log(`[LOCAL] Clearing local backup for ${pendingLocalUserId.value}`);
  }
  clearLastSnapshotUserId();
  pendingLocalUserId.value = null;
  showMissingAgentDialog.value = false;
  startTemporarySession();
};

const handleStartWizardAgain = () => {
  if (pendingLocalUserId.value) {
    console.log(`[LOCAL] Starting wizard again for ${pendingLocalUserId.value}`);
  }
  clearLastSnapshotUserId();
  pendingLocalUserId.value = null;
  showMissingAgentDialog.value = false;
  startTemporarySession();
};

const restoreSavedChats = async (snapshot: any) => {
  const savedChats = snapshot?.savedChats?.chats;
  if (!Array.isArray(savedChats) || savedChats.length === 0) return;

  for (const chat of savedChats) {
    try {
      await fetch('/api/save-group-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          chatHistory: chat.chatHistory || [],
          uploadedFiles: chat.uploadedFiles || [],
          connectedKB: chat.connectedKB || 'No KB connected'
        })
      });
    } catch (error) {
      console.warn('Failed to restore saved chat:', error);
    }
  }
};

const createTemporarySession = async () => {
  const response = await fetch('/api/temporary/start', {
    method: 'POST',
    credentials: 'include'
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Unable to create temporary account');
  }
  if (data.requiresPasskey && data.user) {
    tempStartError.value = `A passkey already exists for ${data.user.userId}. Please use Passkey instead.`;
    passkeyPrefillUserId.value = data.user.userId;
    passkeyPrefillAction.value = 'signin';
    showAuth.value = true;
    return null;
  }
  if (!data.authenticated || !data.user) {
    throw new Error(data.error || 'Unable to create temporary account');
  }
  setAuthenticatedUser(data.user, null);
  return data.user;
};

const handleRestoreSnapshot = async () => {
  if (!restoreSnapshot.value || !user.value?.userId) return;
  restoreLoading.value = true;
  try {
    const snapshot = restoreSnapshot.value;
    const snapshotFiles = Array.isArray(snapshot?.files?.files) ? snapshot.files.files : [];
    const statusSummary = Array.isArray(snapshot?.fileStatusSummary) ? snapshot.fileStatusSummary : [];
    const snapshotKbName = snapshot?.files?.kbName || null;
    const initialFromSnapshot = snapshot?.initialFile || null;
    if (statusSummary.length > 0) {
      rehydrationFiles.value = statusSummary.map((entry: any) => ({
        bucketKey: entry.bucketKey,
        fileName: entry.fileName,
        chipStatus: entry.chipStatus,
        kbName: snapshotKbName
      }));
    } else if (snapshotFiles.length === 0 && Array.isArray(snapshot?.files?.indexedFiles)) {
      rehydrationFiles.value = snapshot.files.indexedFiles.map((bucketKey: string) => ({
        bucketKey,
        fileName: bucketKey.split('/').pop(),
        chipStatus: 'indexed',
        kbName: snapshotKbName
      }));
    } else {
      rehydrationFiles.value = snapshotFiles.map((entry: any) => ({
        bucketKey: entry.bucketKey,
        fileName: entry.fileName,
        chipStatus: 'not_in_kb',
        kbName: snapshotKbName
      }));
    }
    if (initialFromSnapshot && (initialFromSnapshot.bucketKey || initialFromSnapshot.fileName)) {
      const existing = rehydrationFiles.value.find(item =>
        (initialFromSnapshot.bucketKey && item.bucketKey === initialFromSnapshot.bucketKey) ||
        (initialFromSnapshot.fileName && item.fileName === initialFromSnapshot.fileName)
      );
      if (!existing) {
        rehydrationFiles.value.unshift({
          bucketKey: initialFromSnapshot.bucketKey,
          fileName: initialFromSnapshot.fileName,
          chipStatus: 'not_in_kb',
          kbName: snapshotKbName,
          isInitial: true
        });
      } else {
        existing.isInitial = true;
        rehydrationFiles.value = [
          existing,
          ...rehydrationFiles.value.filter(item => item !== existing)
        ];
      }
    }
    rehydrationActive.value = rehydrationFiles.value.length > 0;
    suppressWizard.value = rehydrationActive.value;
    if (rehydrationActive.value) {
      console.log(`[LOCAL] Rehydration started for ${rehydrationFiles.value.length} file(s)`);
      console.log('[LOCAL] Wizard suppressed for rehydration');
      console.log(`[LOCAL] Restore queue for ${user.value.userId}:`);
      rehydrationFiles.value.forEach((entry: any) => {
        const label = entry.fileName || entry.bucketKey || 'unknown';
        const chip = entry.chipStatus || 'unknown';
        console.log(`[LOCAL]  • ${label} (${chip})`);
      });
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'info',
          message: 'Restore in progress: re-upload your files in Saved Files.',
          timeout: 5000
        });
      }
    }
    restoredChatState.value = restoreSnapshot.value.currentChat || null;
    await restoreSavedChats(restoreSnapshot.value);
    if (restoreSnapshot.value.currentMedications) {
      try {
        await fetch('/api/user-current-medications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: user.value.userId,
            currentMedications: restoreSnapshot.value.currentMedications
          })
        });
        console.log('[LOCAL] Current Medications restored');
      } catch (medsError) {
        console.warn('Failed to restore current medications:', medsError);
      }
    }
    if (restoreSnapshot.value.patientSummary) {
      try {
        await fetch('/api/patient-summary', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: user.value.userId,
            summary: restoreSnapshot.value.patientSummary
          })
        });
        console.log('[LOCAL] Patient Summary restored');
      } catch (summaryError) {
        console.warn('Failed to restore patient summary:', summaryError);
      }
    }
    clearLastSnapshotUserId();
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Local backup restored to your new temporary account.',
        timeout: 4000
      });
    }
  } catch (error) {
    console.error('Restore failed:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'Failed to restore local backup.',
        timeout: 4000
      });
    }
  } finally {
    restoreLoading.value = false;
    showRestoreDialog.value = false;
  }
};

const handleSkipRestore = () => {
  showRestoreDialog.value = false;
  restoreSnapshot.value = null;
  suppressWizard.value = false;
};

const handleRehydrationComplete = () => {
  console.log('[LOCAL] Rehydration complete; wizard re-evaluated');
  rehydrationActive.value = false;
  suppressWizard.value = false;
};

const checkDeepLinkSession = async (shareId: string) => {
  deepLinkLoading.value = true;
  deepLinkError.value = '';

  try {
    const response = await fetch(`/api/deep-link/session?shareId=${encodeURIComponent(shareId)}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(response.statusText || 'Failed to verify deep link');
    }

    const result = await response.json();

    if (result.authenticated && result.user) {
      const info: DeepLinkInfo | null = result.deepLinkInfo || (result.deepLink
        ? { shareId, chatId: result.deepLinkInfo?.chatId || null }
        : { shareId, chatId: result.deepLinkInfo?.chatId || null });
      setAuthenticatedUser({ ...result.user, isDeepLink: !!result.deepLink }, info);
      showDeepLinkAccess.value = false;
    } else {
      showDeepLinkAccess.value = true;
    }
  } catch (error) {
    deepLinkError.value = error instanceof Error ? error.message : 'Unable to load invitation';
    showDeepLinkAccess.value = true;
  } finally {
    deepLinkLoading.value = false;
  }
};

const handleSignOut = async (snapshot?: SignOutSnapshot) => {
  signOutSnapshot.value = snapshot || null;
  if (user.value?.isTemporary) {
    showTempSignOutDialog.value = true;
    return;
  }
  try {
    const response = await fetch('/api/user-deep-links', {
      credentials: 'include'
    });
    const data = response.ok ? await response.json() : null;
    const deepLinkCount = data?.count || 0;
    dormantDeepLinkCount.value = deepLinkCount;
    if (deepLinkCount > 0) {
      showDormantDialog.value = true;
      return;
    }
  } catch (error) {
    console.warn('Unable to check deep links for sign-out:', error);
  }

  await handleDormantSignOut();
};

const startTemporarySession = async () => {
  tempStartLoading.value = true;
  tempStartError.value = '';
  try {
    const lastSnapshotUserId = getLastSnapshotUserId();
    if (lastSnapshotUserId) {
      console.log(`[LOCAL] Found local backup userId: ${lastSnapshotUserId}`);
      const agentResponse = await fetch(`/api/agent-exists?userId=${encodeURIComponent(lastSnapshotUserId)}`);
      const agentData = agentResponse.ok ? await agentResponse.json() : null;
      if (agentData && agentData.exists) {
        console.log(`[LOCAL] Agent lookup for ${lastSnapshotUserId}: found`);
        const restoreResponse = await fetch('/api/temporary/restore', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({ userId: lastSnapshotUserId })
        });
        const restoreData = await restoreResponse.json();
        if (restoreResponse.ok && restoreData.authenticated && restoreData.user) {
          setAuthenticatedUser(restoreData.user, null);
        } else {
          throw new Error(restoreData.error || 'Unable to restore temporary account');
        }
      } else if (agentResponse.ok) {
        console.log(`[LOCAL] Agent lookup for ${lastSnapshotUserId}: missing`);
        pendingLocalUserId.value = lastSnapshotUserId;
        missingAgentUserId.value = lastSnapshotUserId;
        showMissingAgentDialog.value = true;
        console.log(`[LOCAL] Missing agent prompt shown for ${lastSnapshotUserId}`);
        tempStartLoading.value = false;
        return;
      }
    } else {
      const newUser = await createTemporarySession();
      if (!newUser) return;
    }

    const effectiveUserId = user.value?.userId;
    if (lastSnapshotUserId && lastSnapshotUserId === effectiveUserId) {
      try {
        const snapshot = await getUserSnapshot(lastSnapshotUserId);
        if (snapshot) {
          restoreSnapshot.value = snapshot;
          showRestoreDialog.value = true;
          suppressWizard.value = true;
          clearWizardPendingKey(lastSnapshotUserId);
          clearWizardPendingKey(effectiveUserId);
        }
      } catch (restoreError) {
        console.warn('Unable to read local backup:', restoreError);
      }
    }
  } catch (error) {
    tempStartError.value = error instanceof Error ? error.message : 'Unable to create temporary account';
  } finally {
    tempStartLoading.value = false;
  }
};

const openDestroyDialog = () => {
  showTempSignOutDialog.value = false;
  destroyConfirm.value = user.value?.userId || '';
  showDestroyDialog.value = true;
};

const startPasskeyRegistration = async () => {
  if (!user.value?.userId) return;
  passkeyPrefillUserId.value = user.value.userId;
  passkeyPrefillAction.value = 'register';
  try {
    const checkResponse = await fetch(`/api/passkey/check-user?userId=${encodeURIComponent(user.value.userId)}`, {
      credentials: 'include'
    });
    if (checkResponse.ok) {
      const checkData = await checkResponse.json();
      if (checkData.exists && checkData.hasPasskey && !checkData.isAdminUser) {
        passkeyPrefillAction.value = 'signin';
      }
    }
  } catch (error) {
    // If check fails, default to registration
  }
  showTempSignOutDialog.value = false;
  showPasskeyDialog.value = true;
};

const destroyTemporaryAccount = async () => {
  if (!user.value?.userId || destroyConfirm.value !== user.value.userId) {
    return;
  }
  destroyLoading.value = true;
  try {
    console.log(`[LOCAL] Snapshot saved for ${user.value.userId}`);
    await saveLocalSnapshot(signOutSnapshot.value);
    const response = await fetch('/api/temporary/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({ userId: user.value.userId })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to delete temporary account');
    }
    resetAuthState();
    showDestroyDialog.value = false;
  } catch (error) {
    console.error('Temporary account deletion error:', error);
  } finally {
    destroyLoading.value = false;
  }
};

const handleDeepLinkInfoUpdate = (info: DeepLinkInfo | null) => {
  if (info?.shareId) {
    deepLinkShareId.value = info.shareId;
  }
  deepLinkInfo.value = info;
};

const loadWelcomeCaption = async () => {
  try {
    const response = await fetch('/api/welcome-caption', {
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      welcomeCaption.value = data.caption || '';
    } else {
      console.warn('Failed to load welcome caption:', response.statusText);
      // Fallback to empty string - will show "Loading..." in template
    }
  } catch (error) {
    console.error('Error loading welcome caption:', error);
    // Fallback to empty string - will show "Loading..." in template
  }
};

const hydrateDeepLinkSession = async (share: string) => {
  try {
    const sessionResponse = await fetch(`/api/deep-link/session?shareId=${encodeURIComponent(share)}`, {
      credentials: 'include'
    });
    if (sessionResponse.ok) {
      const sessionResult = await sessionResponse.json();
      if (sessionResult.authenticated && sessionResult.user) {
        setAuthenticatedUser(
          { ...sessionResult.user, isDeepLink: !!sessionResult.deepLink, deepLinkInfo: sessionResult.deepLinkInfo || null },
          sessionResult.deepLinkInfo || { shareId: share, chatId: null }
        );
        return true;
      }
    }
  } catch (sessionError) {
    console.warn('Unable to hydrate deep-link session:', sessionError);
  }
  return false;
};

if (typeof document !== 'undefined') {
  document.title = DEFAULT_TITLE;
}

onMounted(async () => {
  // Load welcome caption
  loadWelcomeCaption();
  
  // Check for admin page route
  const isAdminPage = window.location.pathname === '/admin';
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  
  if (isAdminPage) {
    showAdminPage.value = true;
    // If running locally, allow admin page without authentication
    if (isLocalhost) {
      authenticated.value = true;
      return;
    }
  }
  
  const params = new URLSearchParams(window.location.search);
  
  // Check for Current Medications editor deep link
  const editMedicationsToken = params.get('editMedications');
  const editMedicationsUserId = params.get('userId');
  
  // Store for later use after authentication
  if (editMedicationsToken && editMedicationsUserId) {
    // Store in sessionStorage for later retrieval after authentication
    sessionStorage.setItem('pendingMedicationsEdit', JSON.stringify({
      token: editMedicationsToken,
      userId: editMedicationsUserId
    }));
    
    // Remove from URL to clean it up
    params.delete('editMedications');
    params.delete('userId');
    const newSearch = params.toString();
    const newUrl = newSearch 
      ? `${window.location.pathname}?${newSearch}${window.location.hash}`
      : `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, '', newUrl);
  }
  
  let share: string | null = null;
  const queryShare = params.get('share');
  if (queryShare) {
    share = queryShare;
  } else {
    const pathMatch = window.location.pathname.match(/\/chat\/(.+)$/);
    if (pathMatch && pathMatch[1]) {
      share = pathMatch[1];
      const newUrl = `${window.location.origin}/?share=${encodeURIComponent(share)}${window.location.hash}`;
      window.history.replaceState({}, '', newUrl);
    }
  }

  // Check if user is already authenticated
  try {
    const response = await fetch('/api/current-user', {
      credentials: 'include'
    });
    const data = await response.json();
    
    if (data.authenticated) {
      const info: DeepLinkInfo | null = data.user?.deepLinkInfo
        ? {
            shareId: data.user.deepLinkInfo.activeShareId || share || (Array.isArray(data.user.deepLinkInfo.shareIds) ? data.user.deepLinkInfo.shareIds[0] : null) || null,
            chatId: data.user.deepLinkInfo.chatId || null
          }
        : (share ? { shareId: share, chatId: null } : null);
      setAuthenticatedUser(data.user, info);
      if (info?.shareId && window.location.search.indexOf(`share=${info.shareId}`) === -1) {
        const normalizedUrl = `${window.location.origin}/?share=${encodeURIComponent(info.shareId)}${window.location.hash}`;
        window.history.replaceState({}, '', normalizedUrl);
      }
      // If user is already authenticated and we have a pending medications edit, 
      // it will be handled in ChatInterface's onMounted
      return;
    }
  } catch (error) {
    console.error('Auth check error:', error);
  }

  if (share) {
    deepLinkShareId.value = share;
    const sessionHydrated = await hydrateDeepLinkSession(share);
    if (sessionHydrated) {
      return;
    }
    showDeepLinkAccess.value = true;
    await checkDeepLinkSession(share);
  }
  
  // Watch for route changes
  const checkRoute = () => {
    const path = window.location.pathname;
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    // Only show admin page if:
    // 1. Path is /admin AND
    // 2. (Running locally OR user is authenticated and we'll let backend handle admin auth)
    if (path === '/admin') {
      if (isLocalhost) {
        showAdminPage.value = true;
      } else if (authenticated.value && user.value?.isAdmin) {
        showAdminPage.value = true;
      } else {
        showAdminPage.value = false;
      }
    } else {
      showAdminPage.value = false;
    }
  };
  
  // Store reference for cleanup before setting up listeners
  checkRouteRef.value = checkRoute;
  
  // Check route on mount and when it changes
  checkRoute();
  window.addEventListener('popstate', checkRoute);
  
  // Use a more reasonable interval for route checking (1 second instead of 100ms)
  // This reduces performance impact while still catching programmatic navigation
  routeCheckInterval.value = setInterval(checkRoute, 1000);
});
</script>

<style>
.q-layout {
  padding: 0 !important;
}

.q-page-container {
  padding: 0 !important;
}

.q-page {
  padding: 0 !important;
}
</style>

