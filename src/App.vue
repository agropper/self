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
            @sign-out="handleSignOut"
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

    <!-- Confirm destroy dialog -->
    <q-dialog v-model="showDestroyDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Destroy Temporary Account</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>Type <strong>{{ user?.userId }}</strong> to confirm deletion.</p>
          <q-input v-model="destroyConfirm" outlined dense />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="CANCEL" color="primary" @click="showDestroyDialog = false" />
          <q-btn
            label="DESTROY"
            color="negative"
            :disable="destroyConfirm !== user?.userId"
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

interface User {
  userId: string;
  displayName: string;
  isDeepLink?: boolean;
  isTemporary?: boolean;
  deepLinkInfo?: DeepLinkInfo | null;
}

interface DeepLinkInfo {
  shareId: string | null;
  chatId?: string | null;
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

const setAuthenticatedUser = (userData: any, deepLink: DeepLinkInfo | null = null) => {
  if (!userData) return;
  const normalizedUser: User = {
    userId: userData.userId,
    displayName: userData.displayName || userData.userId,
    isDeepLink: !!userData.isDeepLink,
    isTemporary: !!userData.isTemporary,
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
    if (isAdminPage && !isLocalhost) {
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
    
    if (isAdminPage && !isLocalhost) {
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

const handleSignOut = async () => {
  if (user.value?.isTemporary) {
    showTempSignOutDialog.value = true;
    return;
  }
  try {
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
  } catch (error) {
    console.error('Sign out error:', error);
  }
};

const startTemporarySession = async () => {
  tempStartLoading.value = true;
  tempStartError.value = '';
  try {
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
      return;
    }
    if (!data.authenticated || !data.user) {
      throw new Error(data.error || 'Unable to create temporary account');
    }
    setAuthenticatedUser(data.user, null);
  } catch (error) {
    tempStartError.value = error instanceof Error ? error.message : 'Unable to create temporary account';
  } finally {
    tempStartLoading.value = false;
  }
};

const openDestroyDialog = () => {
  showTempSignOutDialog.value = false;
  destroyConfirm.value = '';
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
      if (checkData.exists && checkData.hasPasskey) {
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
      } else if (authenticated.value) {
        // In production, only show admin page if user is actually on /admin
        // Backend will enforce admin access
        showAdminPage.value = true;
      } else {
        // Not authenticated and not localhost - don't show admin page
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

