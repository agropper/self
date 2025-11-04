<template>
  <div class="q-gutter-md">
    <!-- Step 1: Choose action -->
    <div v-if="currentStep === 'choose'">
      <q-btn
        label="Sign in with Passkey"
        color="primary"
        icon="login"
        class="full-width q-mb-md"
        @click="startSignInFlow"
      />
      <q-btn
        label="Create New Passkey"
        color="secondary"
        icon="person_add"
        class="full-width"
        @click="startRegistrationFlow"
      />
    </div>

    <!-- Step 2: User ID Input -->
    <div v-if="currentStep === 'userId'">
      <q-input
        ref="userIdInputRef"
        v-model="userId"
        label="User ID"
        outlined
        :rules="[
          (val) => !!val || 'User ID is required',
          (val) => val.length >= 3 || 'User ID must be at least 3 characters',
          (val) => val.length <= 20 || 'User ID must be 20 characters or less',
          (val) => /^[a-z0-9-]+$/.test(val) || 'User ID must contain only lowercase letters, numbers, and hyphens',
          (val) => !val.startsWith('-') && !val.endsWith('-') || 'User ID cannot start or end with a hyphen',
        ]"
        hint="3-20 characters: lowercase letters, numbers, hyphens only"
        @keyup.enter="handleEnterKey"
        class="q-mb-md"
      />
      <q-input
        v-if="action === 'register'"
        v-model="email"
        label="Email (optional)"
        type="email"
        outlined
        hint="Optional: Used for account notifications"
        @keyup.enter="handleEnterKey"
      />

      <div class="row q-gutter-sm q-mt-md">
        <q-btn
          label="Continue"
          color="primary"
          :loading="loading"
          :disable="!userId || userId.length < 3"
          @click="continueAction"
        />
        <q-btn
          label="Back"
          flat
          @click="resetFlow"
        />
      </div>
    </div>

    <!-- Step 3: Registration/Authentication -->
    <div v-if="currentStep === 'registering' || currentStep === 'authenticating'">
      <div class="text-center q-mb-md">
        <q-spinner color="primary" size="3em" />
        <p class="q-mt-md">
          {{ currentStep === 'registering' ? 'Please complete passkey registration...' : 'Please complete passkey authentication...' }}
        </p>
      </div>
      <q-btn label="Cancel" flat @click="resetFlow" />
    </div>

    <!-- Error message -->
    <q-banner
      v-if="error"
      dense
      rounded
      class="bg-red-1 text-red-8 q-mt-md"
    >
      {{ error }}
    </q-banner>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { startRegistration } from '@simplewebauthn/browser';
import { startAuthentication } from '@simplewebauthn/browser';

const emit = defineEmits(['authenticated', 'cancelled']);

const currentStep = ref('choose');
const userId = ref('');
const email = ref('');
const loading = ref(false);
const error = ref('');
const action = ref(''); // 'signin' or 'register'
const userIdInputRef = ref(null);

const startSignInFlow = async () => {
  action.value = 'signin';
  currentStep.value = 'userId';
  await nextTick();
  userIdInputRef.value?.focus();
};

const startRegistrationFlow = async () => {
  action.value = 'register';
  currentStep.value = 'userId';
  await nextTick();
  userIdInputRef.value?.focus();
};

const resetFlow = () => {
  currentStep.value = 'choose';
  userId.value = '';
  email.value = '';
  error.value = '';
  action.value = '';
  loading.value = false;
};

const handleEnterKey = () => {
  if (userId.value && userId.value.length >= 3 && !loading.value) {
    continueAction();
  }
};

const continueAction = async () => {
  loading.value = true;
  error.value = '';

  try {
    if (action.value === 'register') {
      // Check if userId is available before proceeding
      const checkResponse = await fetch(`/api/passkey/check-user?userId=${userId.value}`, {
        credentials: 'include'
      });
      
      if (!checkResponse.ok) {
        const errorData = await checkResponse.json();
        throw new Error(errorData.error || 'Failed to check user ID');
      }

      const checkData = await checkResponse.json();
      
      if (checkData.exists && checkData.hasPasskey) {
        throw new Error('This user ID already has a passkey. Please sign in instead.');
      }
      
      await handleRegistration();
    } else {
      await handleSignIn();
    }
  } catch (err: any) {
    error.value = err.message || 'An error occurred';
  } finally {
    loading.value = false;
  }
};

const handleRegistration = async () => {
  currentStep.value = 'registering';

  // Step 1: Get registration options
  const optionsResponse = await fetch('/api/passkey/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      userId: userId.value,
      displayName: userId.value,
      email: email.value || null
    })
  });

  if (!optionsResponse.ok) {
    const errorData = await optionsResponse.json();
    throw new Error(errorData.error || 'Failed to start registration');
  }

  const options = await optionsResponse.json();

  // Step 2: Create passkey
  const credential = await startRegistration({ optionsJSON: options });

  // Step 3: Verify registration
  const verifyResponse = await fetch('/api/passkey/register-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      userId: userId.value,
      response: credential
    })
  });

  const result = await verifyResponse.json();

  if (result.success) {
    emit('authenticated', result.user);
  } else {
    throw new Error(result.error || 'Registration verification failed');
  }
};

const handleSignIn = async () => {
  currentStep.value = 'authenticating';

  // Step 1: Get authentication options
  const optionsResponse = await fetch('/api/passkey/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      userId: userId.value
    })
  });

  if (!optionsResponse.ok) {
    const errorData = await optionsResponse.json();
    throw new Error(errorData.error || 'Failed to start authentication');
  }

  const options = await optionsResponse.json();

  // Step 2: Authenticate with passkey
  const assertion = await startAuthentication({ optionsJSON: options });

  // Step 3: Verify authentication
  const verifyResponse = await fetch('/api/passkey/authenticate-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      userId: userId.value,
      response: assertion
    })
  });

  const result = await verifyResponse.json();

  if (result.success) {
    emit('authenticated', result.user);
  } else {
    throw new Error(result.error || 'Authentication verification failed');
  }
};
</script>

