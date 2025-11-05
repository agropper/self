<template>
  <q-dialog v-model="isOpen" persistent>
    <q-card style="width: 90vw; height: 90vh; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column;">
      <q-card-section class="row items-center q-pb-none" style="flex-shrink: 0;">
        <div class="text-h5">My Stuff</div>
        <q-space />
        <q-btn icon="close" flat round dense @click="closeDialog" />
      </q-card-section>

      <q-card-section style="flex: 1; overflow-y: auto; min-height: 0;">
        <q-tabs 
          v-model="currentTab" 
          class="text-grey bg-grey-3 rounded-borders"
          active-color="primary" 
          indicator-color="primary" 
          align="justify" 
          style="flex-shrink: 0;"
          dense
        >
          <q-tab name="files" label="Saved Files" icon="description" />
          <q-tab name="agent" label="My AI Agent" icon="smart_toy" />
          <q-tab name="chats" label="Saved Chats" icon="chat" />
          <q-tab name="summary" label="Patient Summary" icon="description" />
        </q-tabs>

        <q-tab-panels v-model="currentTab" animated>
          <!-- Saved Files Tab -->
          <q-tab-panel name="files">
            <div v-if="loadingFiles" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading files...</div>
            </div>

            <div v-else-if="filesError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ filesError }}</div>
              <q-btn label="Retry" color="primary" @click="loadFiles" class="q-mt-md" />
            </div>

            <div v-else-if="userFiles.length === 0" class="text-center q-pa-md text-grey">
              <q-icon name="folder_open" size="3em" />
              <div class="q-mt-sm">No files found</div>
            </div>

            <div v-else class="q-mt-md">
              <q-list>
                <q-item v-for="file in userFiles" :key="file.bucketKey" class="q-pa-md">
                  <q-item-section avatar>
                    <q-checkbox
                      v-model="file.inKnowledgeBase"
                      @update:model-value="onCheckboxChange(file)"
                      :disable="updatingFiles.has(file.bucketKey) || indexingKB"
                    />
                  </q-item-section>
                  <q-item-section>
                    <q-item-label 
                      class="cursor-pointer text-primary"
                      @click="viewFileInPdfViewer(file)"
                    >
                      {{ file.fileName }}
                    </q-item-label>
                    <q-item-label caption>
                      {{ formatFileSize(file.fileSize) }} • Uploaded {{ formatDate(file.uploadedAt) }}
                    </q-item-label>
                  </q-item-section>
                  <q-item-section side>
                    <div class="row items-center q-gutter-xs">
                      <q-chip
                        v-if="!file.inKnowledgeBase"
                        color="amber"
                        text-color="white"
                        size="sm"
                        clickable
                        @click="file.inKnowledgeBase = true; onCheckboxChange(file)"
                      >
                        Add to Knowledge Base
                      </q-chip>
                      <q-chip
                        v-else
                        color="primary"
                        text-color="white"
                        size="sm"
                        clickable
                        @click="file.inKnowledgeBase = false; onCheckboxChange(file)"
                      >
                        In My Knowledge Base
                      </q-chip>
                      <q-btn
                        flat
                        round
                        dense
                        icon="delete"
                        color="negative"
                        @click="confirmDeleteFile(file)"
                        title="Delete file"
                      />
                    </div>
                  </q-item-section>
                </q-item>
              </q-list>
              
              <div v-if="hasCheckboxChanges" class="q-mt-md q-pt-md" style="border-top: 1px solid #e0e0e0;">
                <q-btn
                  label="Update and index knowledge base"
                  color="primary"
                  @click="updateAndIndexKB"
                  :disable="indexingKB"
                  :loading="indexingKB"
                />
              </div>
              
              <div v-if="indexingKB" class="q-mt-md">
                <div class="text-body2">Indexing can take about 200 pages per minute.</div>
                <div class="text-body2 q-mt-xs">KB: {{ indexingStatus.kb || 'Processing...' }}</div>
                <div class="text-body2">Tokens: {{ indexingStatus.tokens || 'Calculating...' }}</div>
                <div class="text-body2">Files indexed: {{ indexingStatus.filesIndexed || 0 }}</div>
              </div>
            </div>
          </q-tab-panel>

          <!-- My AI Agent Tab -->
          <q-tab-panel name="agent">
            <div class="row items-center justify-between q-mb-md">
              <div class="text-h6">Agent Instructions</div>
              <q-btn
                label="EDIT"
                color="primary"
                @click="editMode = !editMode"
                :icon="editMode ? 'close' : 'edit'"
              />
            </div>

            <div v-if="loadingAgent" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading agent...</div>
            </div>

            <div v-else-if="agentError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ agentError }}</div>
              <q-btn label="Retry" color="primary" @click="loadAgent" class="q-mt-md" />
            </div>

            <div v-else-if="agentInstructions">
              <div v-if="editMode" class="q-mb-md">
                <q-input
                  v-model="editedInstructions"
                  type="textarea"
                  rows="15"
                  outlined
                  autofocus
                />
                <div class="q-mt-md">
                  <q-btn label="Save" color="primary" @click="saveInstructions" :loading="savingInstructions" />
                  <q-btn label="Cancel" flat @click="cancelEdit" class="q-ml-sm" />
                </div>
              </div>

              <div v-else>
                <div class="q-mb-md">
                  <vue-markdown :source="agentInstructions" />
                </div>
              </div>
            </div>

            <div v-else class="text-center q-pa-md text-grey">
              <q-icon name="smart_toy" size="3em" />
              <div class="q-mt-sm">No agent found</div>
            </div>
          </q-tab-panel>

          <!-- Saved Chats Tab -->
          <q-tab-panel name="chats">
            <div v-if="loadingChats" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading chats...</div>
            </div>

            <div v-else-if="chatsError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ chatsError }}</div>
              <q-btn label="Retry" color="primary" @click="loadSharedChats" class="q-mt-md" />
            </div>

            <div v-else-if="sharedChats.length === 0" class="text-center q-pa-md text-grey">
              <q-icon name="chat" size="3em" />
              <div class="q-mt-sm">No shared group chats found</div>
            </div>

            <div v-else class="q-mt-md">
              <q-list>
                <q-item
                  v-for="chat in sortedSharedChats"
                  :key="chat._id"
                  clickable
                  class="q-pa-md q-mb-sm"
                  style="border: 1px solid #e0e0e0; border-radius: 8px;"
                  @click="selectChat(chat)"
                >
                  <q-item-section>
                    <q-item-label class="text-weight-medium">
                      {{ formatDate(chat.updatedAt || chat.createdAt) }}
                    </q-item-label>
                    <q-item-label caption class="q-mt-xs">
                      {{ getLastQueryDescription(chat) }}
                    </q-item-label>
                    <q-item-label caption class="q-mt-xs">
                      Group Participants: {{ getGroupParticipants(chat) }}
                    </q-item-label>
                  </q-item-section>
                  <q-item-section side @click.stop>
                    <div class="row items-center q-gutter-xs">
                      <q-btn
                        flat
                        round
                        dense
                        icon="link"
                        color="primary"
                        @click="copyChatLink(chat)"
                        title="Copy deep link"
                      />
                      <q-btn
                        flat
                        round
                        dense
                        icon="delete"
                        color="negative"
                        @click="confirmDeleteChat(chat)"
                        title="Delete chat"
                      />
                    </div>
                  </q-item-section>
                </q-item>
              </q-list>
            </div>
          </q-tab-panel>

          <!-- Patient Summary Tab -->
          <q-tab-panel name="summary">
            <div v-if="loadingSummary" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading patient summary...</div>
            </div>

            <div v-else-if="summaryError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ summaryError }}</div>
              <q-btn label="Retry" color="primary" @click="loadPatientSummary" class="q-mt-md" />
            </div>

            <div v-else-if="patientSummary" class="q-mt-md">
              <div class="text-body1 q-pa-md bg-grey-1 rounded-borders" style="white-space: pre-wrap;">
                {{ patientSummary }}
              </div>
              <div class="q-mt-md">
                <q-btn 
                  label="Request New Summary" 
                  color="primary" 
                  @click="requestNewSummary"
                  icon="refresh"
                />
              </div>
            </div>

            <div v-else class="text-center q-pa-md text-grey">
              <q-icon name="description" size="3em" />
              <div class="q-mt-sm">No patient summary found</div>
              <div class="q-mt-md">
                <q-btn 
                  label="Request Summary" 
                  color="primary" 
                  @click="requestNewSummary"
                  icon="add"
                />
              </div>
            </div>
          </q-tab-panel>
        </q-tab-panels>
      </q-card-section>
    </q-card>
    
    <!-- PDF Viewer Modal -->
    <PdfViewerModal
      v-model="showPdfViewer"
      :file="viewingFile"
    />
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import VueMarkdown from 'vue-markdown-render';
import PdfViewerModal from './PdfViewerModal.vue';
import { useQuasar } from 'quasar';

interface UserFile {
  fileName: string;
  bucketKey: string;
  fileSize: number;
  uploadedAt: string;
  inKnowledgeBase: boolean;
  knowledgeBases?: string[];
}

interface SavedChat {
  _id: string;
  type: string;
  shareId: string;
  currentUser: string;
  patientOwner?: string;
  chatHistory: any[];
  uploadedFiles: any[];
  createdAt: string;
  updatedAt: string;
  isShared?: boolean;
}

interface Props {
  modelValue: boolean;
  userId: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'chat-selected': [chat: SavedChat];
}>();

const isOpen = ref(props.modelValue);
const currentTab = ref('files');
const loadingFiles = ref(false);
const filesError = ref('');
const userFiles = ref<UserFile[]>([]);
const updatingFiles = ref(new Set<string>());

const loadingAgent = ref(false);
const agentError = ref('');
const agentInstructions = ref('');
const editMode = ref(false);
const editedInstructions = ref('');
const savingInstructions = ref(false);

const loadingChats = ref(false);
const chatsError = ref('');
const sharedChats = ref<SavedChat[]>([]);

// Patient Summary
const loadingSummary = ref(false);
const summaryError = ref('');
const patientSummary = ref('');

// PDF Viewer
const showPdfViewer = ref(false);
const viewingFile = ref<any>(null);

// KB management
const originalFiles = ref<UserFile[]>([]);
const hasCheckboxChanges = computed(() => {
  if (originalFiles.value.length !== userFiles.value.length) return true;
  return userFiles.value.some((file, index) => {
    const original = originalFiles.value[index];
    return !original || file.inKnowledgeBase !== original.inKnowledgeBase;
  });
});
const indexingKB = ref(false);
const indexingStatus = ref({
  kb: '',
  tokens: '',
  filesIndexed: 0
});
const currentIndexingJobId = ref<string | null>(null);

const $q = useQuasar();

const loadFiles = async () => {
  loadingFiles.value = true;
  filesError.value = '';

  try {
    const response = await fetch(`http://localhost:3001/api/user-files?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch files: ${response.statusText}`);
    }
    const result = await response.json();
    userFiles.value = (result.files || []).map((file: any) => ({
      ...file,
      inKnowledgeBase: file.knowledgeBases && file.knowledgeBases.length > 0
    }));
    originalFiles.value = JSON.parse(JSON.stringify(userFiles.value));
  } catch (err) {
    filesError.value = err instanceof Error ? err.message : 'Failed to load files';
  } finally {
    loadingFiles.value = false;
  }
};

const toggleKnowledgeBase = async (file: UserFile) => {
  updatingFiles.value.add(file.bucketKey);

  try {
    const response = await fetch('http://localhost:3001/api/toggle-file-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        bucketKey: file.bucketKey,
        inKnowledgeBase: file.inKnowledgeBase
      })
    });

    if (!response.ok) {
      throw new Error('Failed to update knowledge base status');
    }

    // Reload files to get updated state
    await loadFiles();
  } catch (err) {
    filesError.value = err instanceof Error ? err.message : 'Failed to update knowledge base status';
    // Revert checkbox on error
    file.inKnowledgeBase = !file.inKnowledgeBase;
  } finally {
    updatingFiles.value.delete(file.bucketKey);
  }
};

const loadAgent = async () => {
  loadingAgent.value = true;
  agentError.value = '';

  try {
    const response = await fetch(`http://localhost:3001/api/agent-instructions?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch agent: ${response.statusText}`);
    }
    const result = await response.json();
    agentInstructions.value = result.instructions || '';
    editedInstructions.value = result.instructions || '';
  } catch (err) {
    agentError.value = err instanceof Error ? err.message : 'Failed to load agent';
  } finally {
    loadingAgent.value = false;
  }
};

const saveInstructions = async () => {
  savingInstructions.value = true;

  try {
    const response = await fetch('http://localhost:3001/api/agent-instructions', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        instructions: editedInstructions.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save instructions');
    }

    agentInstructions.value = editedInstructions.value;
    editMode.value = false;
  } catch (err) {
    agentError.value = err instanceof Error ? err.message : 'Failed to save instructions';
  } finally {
    savingInstructions.value = false;
  }
};

const cancelEdit = () => {
  editedInstructions.value = agentInstructions.value;
  editMode.value = false;
};

const loadSharedChats = async () => {
  loadingChats.value = true;
  chatsError.value = '';

  try {
    const response = await fetch(`http://localhost:3001/api/shared-group-chats?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch chats: ${response.statusText}`);
    }
    const result = await response.json();
    sharedChats.value = result.chats || [];
  } catch (err) {
    chatsError.value = err instanceof Error ? err.message : 'Failed to load chats';
  } finally {
    loadingChats.value = false;
  }
};

const getLastQueryDescription = (chat: SavedChat): string => {
  if (!chat.chatHistory || chat.chatHistory.length === 0) {
    return 'No messages';
  }

  // Find the last user message
  for (let i = chat.chatHistory.length - 1; i >= 0; i--) {
    if (chat.chatHistory[i].role === 'user' && chat.chatHistory[i].content) {
      const content = chat.chatHistory[i].content;
      // Return first 100 characters
      return content.length > 100 ? content.substring(0, 100) + '...' : content;
    }
  }

  return 'No user query found';
};

const getGroupParticipants = (chat: SavedChat): string => {
  if (!chat.isShared || !chat.currentUser) {
    return 'None';
  }

  // For now, just return the current user
  // TODO: Extract all participants from chat history
  return chat.currentUser;
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatFileSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

// File management methods
const onCheckboxChange = async (file: UserFile) => {
  // Immediately move file when checkbox is toggled
  const oldBucketKey = file.bucketKey;
  const newStatus = file.inKnowledgeBase;
  
  console.log(`[KB Management] Toggling file ${file.fileName}: KB status = ${newStatus}, bucketKey = ${oldBucketKey}`);
  
  updatingFiles.value.add(file.bucketKey);

  try {
    const response = await fetch('http://localhost:3001/api/toggle-file-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        bucketKey: oldBucketKey,
        inKnowledgeBase: newStatus
      })
    });

    if (!response.ok) {
      throw new Error('Failed to update knowledge base status');
    }

    const result = await response.json();
    
    // Update file's bucketKey if it changed
    if (result.newBucketKey && result.newBucketKey !== oldBucketKey) {
      file.bucketKey = result.newBucketKey;
      console.log(`[KB Management] ✅ File bucketKey updated: ${oldBucketKey} -> ${result.newBucketKey}`);
    }
    
    // Update original files to reflect the change
    const originalIndex = originalFiles.value.findIndex(f => f.bucketKey === oldBucketKey);
    if (originalIndex >= 0) {
      originalFiles.value[originalIndex].inKnowledgeBase = newStatus;
      if (result.newBucketKey) {
        originalFiles.value[originalIndex].bucketKey = result.newBucketKey;
      }
    }
    
    console.log(`[KB Management] ✅ File ${file.fileName} successfully ${newStatus ? 'added to' : 'removed from'} knowledge base`);
  } catch (err) {
    console.error(`[KB Management] ❌ Error toggling file ${file.fileName}:`, err);
    // Revert checkbox on error
    file.inKnowledgeBase = !newStatus;
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to update knowledge base status'
    });
  } finally {
    updatingFiles.value.delete(oldBucketKey);
  }
};

const viewFileInPdfViewer = (file: UserFile) => {
  viewingFile.value = {
    bucketKey: file.bucketKey,
    name: file.fileName
  };
  showPdfViewer.value = true;
};

const confirmDeleteFile = (file: UserFile) => {
  $q.dialog({
    title: 'Delete File',
    message: 'This will delete the file from MAIA, remove it from the knowledge base, and re-index. Make sure you have copies of your valuable files on your computer.',
    cancel: true,
    persistent: true
  }).onOk(() => {
    deleteFile(file);
  });
};

const deleteFile = async (file: UserFile) => {
  try {
    const response = await fetch(`http://localhost:3001/api/delete-file`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        bucketKey: file.bucketKey
      })
    });

    if (!response.ok) {
      throw new Error('Failed to delete file');
    }

    // Reload files
    await loadFiles();
    $q.notify({
      type: 'positive',
      message: 'File deleted successfully'
    });
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to delete file'
    });
  }
};

const updateAndIndexKB = async () => {
  indexingKB.value = true;
  indexingStatus.value = { kb: '', tokens: '', filesIndexed: 0 };

  try {
    // Get changed files
    const changes = userFiles.value.map((file, index) => {
      const original = originalFiles.value[index];
      if (!original || file.inKnowledgeBase !== original.inKnowledgeBase) {
        return {
          bucketKey: file.bucketKey,
          inKnowledgeBase: file.inKnowledgeBase
        };
      }
      return null;
    }).filter(Boolean);

    const response = await fetch('http://localhost:3001/api/update-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        changes: changes
      })
    });

    if (!response.ok) {
      throw new Error('Failed to update knowledge base');
    }

    const result = await response.json();
    
    if (result.jobId) {
      currentIndexingJobId.value = result.jobId;
      pollIndexingProgress(result.jobId);
    }

    // Update original files
    originalFiles.value = JSON.parse(JSON.stringify(userFiles.value));
  } catch (err) {
    indexingKB.value = false;
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to update knowledge base'
    });
  }
};

const pollIndexingProgress = async (jobId: string) => {
  const pollInterval = setInterval(async () => {
    try {
      const response = await fetch(`http://localhost:3001/api/kb-indexing-status/${jobId}`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to get indexing status');
      }

      const result = await response.json();
      indexingStatus.value = {
        kb: result.kb || '',
        tokens: result.tokens || '',
        filesIndexed: result.filesIndexed || 0
      };

      if (result.completed) {
        clearInterval(pollInterval);
        indexingKB.value = false;
        await loadFiles();
        $q.notify({
          type: 'positive',
          message: 'Knowledge base updated successfully'
        });
      }
    } catch (err) {
      clearInterval(pollInterval);
      indexingKB.value = false;
      console.error('Error polling indexing status:', err);
    }
  }, 2000); // Poll every 2 seconds
};

// Chat management methods
const selectChat = async (chat: SavedChat) => {
  try {
    // Fetch full chat data first
    const response = await fetch(`http://localhost:3001/api/load-chat/${chat._id}`, {
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error(`Failed to load chat: ${response.statusText}`);
    }
    
    const result = await response.json();
    emit('chat-selected', result.chat);
    closeDialog();
  } catch (err) {
    console.error('Failed to load full chat data:', err);
    // Fallback: emit the chat we have
    emit('chat-selected', chat);
    closeDialog();
  }
};

const copyChatLink = (chat: SavedChat) => {
  const baseUrl = window.location.origin;
  const link = `${baseUrl}/chat/${chat.shareId}`;
  navigator.clipboard.writeText(link).then(() => {
    $q.notify({
      type: 'positive',
      message: 'Deep link copied to clipboard'
    });
  }).catch(() => {
    $q.notify({
      type: 'negative',
      message: 'Failed to copy link'
    });
  });
};

const confirmDeleteChat = (chat: SavedChat) => {
  $q.dialog({
    title: 'Delete Chat',
    message: 'Are you sure you want to delete this chat?',
    cancel: true,
    persistent: true
  }).onOk(() => {
    deleteChat(chat);
  });
};

const deleteChat = async (chat: SavedChat) => {
  try {
    const response = await fetch(`http://localhost:3001/api/delete-chat/${chat._id}`, {
      method: 'DELETE',
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error('Failed to delete chat');
    }

    // Remove from list
    sharedChats.value = sharedChats.value.filter(c => c._id !== chat._id);
    $q.notify({
      type: 'positive',
      message: 'Chat deleted successfully'
    });
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to delete chat'
    });
  }
};

// Patient Summary methods
const loadPatientSummary = async () => {
  loadingSummary.value = true;
  summaryError.value = '';

  try {
    const response = await fetch(`http://localhost:3001/api/patient-summary?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch patient summary: ${response.statusText}`);
    }
    
    const result = await response.json();
    patientSummary.value = result.summary || '';
  } catch (err) {
    summaryError.value = err instanceof Error ? err.message : 'Failed to load patient summary';
  } finally {
    loadingSummary.value = false;
  }
};

const requestNewSummary = () => {
  // Close the dialog and emit an event to trigger summary request
  // This will be handled by ChatInterface
  emit('update:modelValue', false);
  // The actual summary request will be handled by ChatInterface when user types "patient summary"
  $q.notify({
    type: 'info',
    message: 'Type "patient summary" in the chat to generate a new summary'
  });
};

const sortedSharedChats = computed(() => {
  return [...sharedChats.value].sort((a, b) => {
    const dateA = new Date(a.updatedAt || a.createdAt);
    const dateB = new Date(b.updatedAt || b.createdAt);
    return dateB.getTime() - dateA.getTime();
  });
});

const closeDialog = () => {
  isOpen.value = false;
};

watch(() => props.modelValue, (newValue) => {
  isOpen.value = newValue;
  if (newValue) {
    // Load data when dialog opens
    if (currentTab.value === 'files') {
      loadFiles();
    } else if (currentTab.value === 'agent') {
      loadAgent();
    } else if (currentTab.value === 'chats') {
      loadSharedChats();
    }
  }
});

watch(isOpen, (newValue) => {
  emit('update:modelValue', newValue);
});

watch(currentTab, (newTab) => {
  if (isOpen.value) {
    if (newTab === 'files') {
      loadFiles();
    } else if (newTab === 'agent') {
      loadAgent();
    } else if (newTab === 'chats') {
      loadSharedChats();
    } else if (newTab === 'summary') {
      loadPatientSummary();
    }
  }
});
</script>

<style scoped lang="scss">
.q-item {
  cursor: default;
}
</style>
