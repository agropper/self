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
        label="Email"
        type="email"
        outlined
        :rules="[
          (val) => !!val || 'Email is required',
          (val) => /.+@.+\..+/.test(val) || 'Please enter a valid email address'
        ]"
        hint="Required for account notifications."
        @keyup.enter="handleEnterKey"
      />

      <div class="row q-gutter-sm q-mt-md">
        <q-btn
          label="Continue"
          color="primary"
          :loading="loading"
          :disable="!userId || userId.length < 3 || (action === 'register' && !email)"
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

  <!-- File Import Dialog - Step 1: Choose file -->
  <q-dialog v-model="showFileImportDialog" persistent>
    <q-card style="min-width: 400px; max-width: 500px">
      <q-card-section>
        <div class="text-h6">Import Initial Health Record</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <p class="text-body2">
          If you have an Apple Health Export PDF file or another initial health record file, import it for your initial knowledge base. You will be able to add other health records files later, at any time.
        </p>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <input
          ref="fileInputRef"
          type="file"
          accept=".pdf,.txt,.md"
          style="display: none"
          @change="handleFileSelected"
        />
        <q-btn
          label="CHOOSE FILE"
          color="primary"
          class="full-width"
          @click="triggerFileInput"
          :loading="uploadingFile"
        />
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Cancel" @click="handleFileImportCancel" />
      </q-card-actions>
    </q-card>
  </q-dialog>

  <!-- File Import Dialog - Step 2: Confirm without file -->
  <q-dialog v-model="showConfirmWithoutFileDialog" persistent>
    <q-card style="min-width: 400px; max-width: 500px">
      <q-card-section>
        <div class="text-h6">Continue Without File</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <p class="text-body2">
          You can request a private AI without including a file. You will be able to add health records using Import (the paper clip) and the Saved Files tab in MyStuff at a later time.
        </p>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="I WANT TO ADD A FILE" @click="goBackToFileChooser" />
        <q-btn label="SEND SUPPORT REQUEST ANYWAY" color="primary" @click="sendRequestWithoutFile" />
      </q-card-actions>
    </q-card>
  </q-dialog>
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
const userIdInputRef = ref<HTMLInputElement | null>(null);
const showFileImportDialog = ref(false);
const showConfirmWithoutFileDialog = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const uploadingFile = ref(false);
const kbName = ref<string | null>(null);

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
  showFileImportDialog.value = false;
  showConfirmWithoutFileDialog.value = false;
  kbName.value = null;
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
    // If showFileImport flag is set, show file import dialog instead of immediately authenticating
    if (result.showFileImport && result.kbName) {
      console.log('[NEW FLOW] Showing file import dialog');
      kbName.value = result.kbName;
      showFileImportDialog.value = true;
      // Don't emit authenticated yet - wait for file upload or user to proceed
    } else {
      emit('authenticated', result.user);
    }
  } else {
    throw new Error(result.error || 'Registration verification failed');
  }
};

const triggerFileInput = () => {
  fileInputRef.value?.click();
};

const handleFileSelected = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  uploadingFile.value = true;
  try {
    console.log('[NEW FLOW] Uploading initial file to KB folder:', file.name);
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('subfolder', kbName.value || ''); // Upload to KB subfolder
    formData.append('isInitialImport', 'true'); // Flag for initial import

    const uploadResponse = await fetch('/api/files/upload', {
      method: 'POST',
      credentials: 'include',
      body: formData
    });

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json();
      throw new Error(errorData.error || 'Failed to upload file');
    }

    const uploadResult = await uploadResponse.json();
    console.log('[NEW FLOW] File uploaded successfully:', uploadResult);

    // Notify backend that initial file upload is complete
    const completeResponse = await fetch('/api/passkey/registration-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: userId.value,
        initialFile: {
          fileName: uploadResult.fileInfo.fileName,
          bucketKey: uploadResult.fileInfo.bucketKey,
          fileSize: uploadResult.fileInfo.size,
          uploadedAt: new Date().toISOString()
        }
      })
    });

    if (!completeResponse.ok) {
      throw new Error('Failed to complete registration');
    }

    const completeResult = await completeResponse.json();
    console.log('[NEW FLOW] Registration complete, admin email sent');

    showFileImportDialog.value = false;
    emit('authenticated', completeResult.user);
  } catch (err: any) {
    error.value = err.message || 'Failed to upload file';
    console.error('[NEW FLOW] File upload error:', err);
  } finally {
    uploadingFile.value = false;
    // Reset file input
    if (fileInputRef.value) {
      fileInputRef.value.value = '';
    }
  }
};

const handleFileImportCancel = () => {
  showFileImportDialog.value = false;
  showConfirmWithoutFileDialog.value = true;
};

const goBackToFileChooser = () => {
  showConfirmWithoutFileDialog.value = false;
  showFileImportDialog.value = true;
};

const sendRequestWithoutFile = async () => {
  loading.value = true;
  try {
    console.log('[NEW FLOW] User proceeding without file, sending admin email');
    
    const response = await fetch('/api/passkey/registration-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: userId.value,
        initialFile: null // No file uploaded
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to complete registration');
    }

    const result = await response.json();
    console.log('[NEW FLOW] Registration complete without file, admin email sent');

    showConfirmWithoutFileDialog.value = false;
    emit('authenticated', result.user);
  } catch (err: any) {
    error.value = err.message || 'Failed to complete registration';
    console.error('[NEW FLOW] Registration completion error:', err);
  } finally {
    loading.value = false;
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

