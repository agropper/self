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
                      <!-- Not in KB - show amber "Add to Knowledge Base" -->
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
                      <!-- In KB but not indexed - show warning "Needs Indexing" -->
                      <q-chip
                        v-else-if="file.inKnowledgeBase && !indexedFiles.includes(file.bucketKey)"
                        color="orange"
                        text-color="white"
                        size="sm"
                        clickable
                        @click="file.inKnowledgeBase = false; onCheckboxChange(file)"
                      >
                        Needs Indexing
                      </q-chip>
                      <!-- In KB and indexed - show primary "Indexed in Knowledge Base" -->
                      <q-chip
                        v-else
                        color="primary"
                        text-color="white"
                        size="sm"
                        clickable
                        @click="file.inKnowledgeBase = false; onCheckboxChange(file)"
                      >
                        Indexed in Knowledge Base
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
              
              <div v-if="hasCheckboxChanges || kbIndexingOutOfSync" class="q-mt-md q-pt-md" style="border-top: 1px solid #e0e0e0;">
                <div v-if="kbIndexingOutOfSync && !hasCheckboxChanges" class="q-mb-md text-body2 text-amber-9">
                  You have changed the files to be indexed into your knowledge base. Click to index when ready.
                </div>
                <div class="row q-gutter-sm">
                <q-btn
                  label="Update and index knowledge base"
                  color="primary"
                  @click="updateAndIndexKB"
                    :disable="indexingKB || resettingKB"
                  :loading="indexingKB"
                />
                  <q-btn
                    v-if="isDevelopment"
                    label="RESET KB"
                    color="negative"
                    outline
                    @click="resetKB"
                    :disable="indexingKB || resettingKB"
                    :loading="resettingKB"
                  />
                </div>
              </div>
              
              <!-- Phase 1: Moving files -->
              <div v-if="indexingKB && indexingStatus.phase === 'moving'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Moving files to knowledge base folder...' }}</div>
              </div>

              <!-- Phase 2: KB Setup -->
              <div v-if="indexingKB && indexingStatus.phase === 'kb_setup'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Setting up knowledge base...' }}</div>
                <div v-if="indexingStatus.kb" class="text-caption text-grey-7 q-mt-xs">KB: {{ indexingStatus.kb }}</div>
              </div>

              <!-- Phase 3: Indexing Started -->
              <div v-if="indexingKB && indexingStatus.phase === 'indexing_started'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Indexing job started...' }}</div>
                <div class="text-caption text-grey-7 q-mt-xs">This may take several minutes</div>
              </div>

              <!-- Phase 4: Indexing In Progress -->
              <div v-if="indexingKB && indexingStatus.phase === 'indexing'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress 
                  :value="indexingStatus.progress || 0" 
                  color="primary" 
                  animated
                  class="q-mb-sm"
                />
                <div class="text-body2">Indexing in progress...</div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  <span v-if="indexingStatus.kb">KB: {{ indexingStatus.kb }} • </span>
                  Tokens: {{ indexingStatus.tokens || 'Calculating...' }} • 
                  Files: {{ indexingStatus.filesIndexed || 0 }}
                </div>
                <div class="text-caption text-grey-6 q-mt-xs">
                  Indexing can take about 200 pages per minute.
                </div>
              </div>

              <!-- Phase 5: Complete -->
              <div v-if="indexingKB && indexingStatus.phase === 'complete'" class="q-mt-md q-pa-md" style="background-color: #e8f5e9; border-radius: 4px; border: 1px solid #4caf50;">
                <div class="text-body2 text-positive">
                  ✅ {{ indexingStatus.message || 'Knowledge base indexed successfully!' }}
                </div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  <span v-if="indexingStatus.kb">KB: {{ indexingStatus.kb }} • </span>
                  Tokens: {{ indexingStatus.tokens }} • 
                  Files: {{ indexingStatus.filesIndexed }}
                </div>
              </div>

              <!-- Phase 6: Error -->
              <div v-if="indexingKB && indexingStatus.phase === 'error'" class="q-mt-md q-pa-md" style="background-color: #ffebee; border-radius: 4px; border: 1px solid #f44336;">
                <div class="text-body2 text-negative">
                  ❌ {{ indexingStatus.error || 'Indexing failed' }}
                </div>
                <div v-if="indexingStatus.kb" class="text-caption text-grey-7 q-mt-xs">KB: {{ indexingStatus.kb }}</div>
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

            <!-- Deep link Private AI access switch -->
            <div class="row items-center justify-center q-mb-md">
              <q-toggle
                v-model="allowDeepLinkPrivateAI"
                label="Deep link users can chat with your Private AI"
                color="primary"
                :loading="savingDeepLinkSetting"
                @update:model-value="saveDeepLinkPrivateAISetting"
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

              <!-- Agent Knowledge Base Section -->
              <div v-if="kbInfo" class="q-mt-lg" style="border-top: 1px solid #e0e0e0; padding-top: 16px;">
                <div class="text-h6 q-mb-md">Agent Knowledge Base</div>
                
                <div class="row items-center q-mb-sm">
                  <div class="col">
                    <div class="text-weight-medium">{{ kbInfo.name }}</div>
                    <div class="text-caption text-grey-7 q-mt-xs">
                      Last indexed: {{ formatRelativeTime(kbInfo.lastIndexedAt) }}
                    </div>
                  </div>
                  <div class="col-auto">
                    <q-chip
                      :color="kbInfo.connected ? 'green' : 'amber'"
                      text-color="white"
                      :label="kbInfo.connected ? 'Connected' : 'Not Connected'"
                      clickable
                      @click="toggleKBConnection"
                      :disable="togglingKB"
                      :loading="togglingKB"
                    />
                  </div>
                </div>
                
                <div class="q-mt-md">
                  <div class="text-caption text-grey-7 q-mb-xs">Indexed Files:</div>
                  <div 
                    v-if="indexedFileNames.length === 0"
                    class="text-caption text-grey-5"
                  >
                    No files indexed yet
                  </div>
                  <q-list
                    v-else
                    dense
                    :class="{ 'text-grey-5': !kbInfo.connected }"
                  >
                    <q-item
                      v-for="(fileName, index) in indexedFileNames"
                      :key="index"
                      dense
                    >
                      <q-item-section>
                        <q-item-label 
                          :class="{ 'text-grey-5': !kbInfo.connected }"
                          class="text-caption"
                        >
                          {{ fileName }}
                        </q-item-label>
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
              </div>

              <div v-else-if="!loadingAgent" class="q-mt-lg text-center text-grey-7">
                <div class="text-caption">No knowledge base configured</div>
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
                    <q-item-label v-if="chat.shareId" caption class="q-mt-xs text-primary">
                      <q-icon name="link" size="xs" />
                      Deep link: /chat/{{ chat.shareId }}
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
              <div class="row items-center justify-between q-gutter-sm q-mb-sm">
                <div class="text-caption text-grey-7">
                  <!-- Patient summary editing -->
              </div>
                <div class="row q-gutter-sm">
                  <q-btn
                    v-if="!isEditingSummaryTab"
                    outline
                    label="Edit"
                    color="primary"
                    icon="edit"
                    @click="startSummaryEdit"
                  />
                  <q-btn
                    v-else
                    flat
                    label="Cancel"
                    color="grey-8"
                    icon="close"
                    @click="cancelSummaryEdit"
                    :disable="isSavingSummary"
                  />
                </div>
              </div>

              <div v-if="isEditingSummaryTab">
                <q-input
                  v-model="summaryEditText"
                  type="textarea"
                  autogrow
                  filled
                  class="bg-grey-1 rounded-borders"
                  :disable="isSavingSummary"
                  placeholder="Enter patient summary..."
                />
              </div>
              <div v-else class="text-body1 q-pa-md bg-grey-1 rounded-borders">
                <vue-markdown :source="patientSummary" />
              </div>

              <div class="row items-center q-gutter-sm q-mt-md">
                <q-btn
                  v-if="isEditingSummaryTab"
                  label="Save"
                  color="primary"
                  icon="save"
                  @click="saveSummaryFromTab"
                  :loading="isSavingSummary"
                  :disable="isSavingSummary"
                />
                <q-space />
                <q-btn 
                  label="Request New Summary" 
                  color="primary" 
                  @click="requestNewSummary"
                  icon="refresh"
                  :disable="isEditingSummaryTab || isSavingSummary"
                  :loading="loadingSummary"
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

    <!-- Patient Summary Available Modal -->
    <q-dialog v-model="showSummaryAvailableModal" persistent>
      <q-card style="min-width: 400px; max-width: 600px;">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">New Patient Summary Available</div>
        </q-card-section>

        <q-card-section>
          <div class="text-body1">
            A new patient summary has been generated based on your updated knowledge base.
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md">
          <q-btn 
            flat 
            label="CLOSE MyStuff" 
            color="grey-8" 
            @click="handleCloseMyStuff"
          />
          <q-btn 
            flat 
            label="SAVE SUMMARY" 
            color="primary" 
            @click="handleSaveSummary"
          />
          <q-btn 
            label="VIEW SUMMARY" 
            color="primary" 
            @click="handleViewSummary"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Patient Summary View Modal -->
    <q-dialog v-model="showSummaryViewModal" persistent>
      <q-card style="min-width: 600px; max-width: 900px; max-height: 80vh;">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Patient Summary</div>
          <q-space />
          <q-btn icon="close" flat round dense @click="handleCloseWithoutSaving" />
        </q-card-section>

        <q-card-section style="max-height: 60vh; overflow-y: auto;">
          <div v-if="!editingSummary" class="text-body2">
            <vue-markdown :source="summaryViewText" />
          </div>
          <q-input
            v-else
            v-model="summaryViewText"
            type="textarea"
            autofocus
            rows="20"
            filled
            style="width: 100%;"
          />
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md">
          <q-btn 
            flat 
            label="CLOSE WITHOUT SAVING" 
            color="grey-8" 
            @click="handleCloseWithoutSaving"
          />
          <q-btn 
            v-if="editingSummary"
            label="SAVE" 
            color="primary" 
            @click="handleSaveEditedSummary"
          />
          <q-btn 
            v-else
            label="EDIT" 
            color="primary" 
            @click="handleEditSummary"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import VueMarkdown from 'vue-markdown-render';
import PdfViewerModal from './PdfViewerModal.vue';
import { useQuasar } from 'quasar';
import { deleteChatById } from '../utils/chatApi';

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
  'indexing-started': [data: { jobId: string; phase: string }];
  'indexing-status-update': [data: { jobId: string; phase: string; tokens: string; filesIndexed: number; progress: number }];
  'indexing-finished': [data: { jobId: string; phase: string; error?: string }];
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

// Deep link Private AI access setting
const allowDeepLinkPrivateAI = ref(true); // Default to enabled
const savingDeepLinkSetting = ref(false);

// KB info for agent tab
const kbInfo = ref<{
  name: string;
  kbId: string;
  connected: boolean;
  indexedFiles: string[];
  lastIndexedAt: string | null;
} | null>(null);
const togglingKB = ref(false);

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
const indexedFiles = ref<string[]>([]); // Track which files are actually indexed
const hasCheckboxChanges = computed(() => {
  if (originalFiles.value.length !== userFiles.value.length) return true;
  return userFiles.value.some((file, index) => {
    const original = originalFiles.value[index];
    return !original || file.inKnowledgeBase !== original.inKnowledgeBase;
  });
});
// Check if KB folder contents match indexed files
const kbIndexingOutOfSync = computed(() => {
  // Get all files currently in KB folder (inKnowledgeBase = true)
  const currentKBFiles = userFiles.value
    .filter(file => file.inKnowledgeBase)
    .map(file => file.bucketKey);
  
  // Sort both arrays for comparison
  const currentSorted = [...currentKBFiles].sort();
  const indexedSorted = [...indexedFiles.value].sort();
  
  // Compare arrays
  if (currentSorted.length !== indexedSorted.length) return true;
  return currentSorted.some((key, index) => key !== indexedSorted[index]);
});
const indexingKB = ref(false);
const resettingKB = ref(false);
const indexingStatus = ref({
  phase: 'moving', // 'moving' | 'kb_setup' | 'indexing_started' | 'indexing' | 'complete' | 'error'
  message: '',
  kb: '',
  tokens: '',
  filesIndexed: 0,
  progress: 0,
  error: ''
});

// Check if we're in development/localhost (show RESET KB button only in dev)
const isDevelopment = computed(() => {
  if (typeof window === 'undefined') return false;
  return import.meta.env.DEV || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
});
const currentIndexingJobId = ref<string | null>(null);
const pollingInterval = ref<ReturnType<typeof setInterval> | null>(null);
const indexingStartTime = ref<number | null>(null);
const INDEXING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Patient summary modal state
const showSummaryAvailableModal = ref(false);
const showSummaryViewModal = ref(false);
const newPatientSummary = ref('');
const editingSummary = ref(false);
const summaryViewText = ref('');
const isEditingSummaryTab = ref(false);
const summaryEditText = ref('');
const isSavingSummary = ref(false);

watch(patientSummary, (newValue) => {
  if (!isEditingSummaryTab.value) {
    summaryEditText.value = newValue || '';
  }
});

const hasUnsavedAgentChanges = computed(() => {
  if (!editMode.value) return false;
  const current = (editedInstructions.value || '').trim();
  const original = (agentInstructions.value || '').trim();
  return current !== original;
});

const hasUnsavedSummaryChanges = computed(() => {
  if (!isEditingSummaryTab.value) return false;
  const current = (summaryEditText.value || '').trim();
  const original = (patientSummary.value || '').trim();
  return current !== original;
});

const hasUnsavedChanges = computed(() => hasUnsavedAgentChanges.value || hasUnsavedSummaryChanges.value);

const $q = useQuasar();

const loadFiles = async () => {
  loadingFiles.value = true;
  filesError.value = '';

  try {
    // First, auto-archive any files at root level (userId/)
    // This ensures files imported via paper clip are moved to archived when opening SAVED FILES tab
    try {
      await fetch('/api/archive-user-files', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          userId: props.userId
        })
      });
      // Don't fail if archiving fails - just continue to load files
    } catch (archiveErr) {
      console.warn('Failed to auto-archive files:', archiveErr);
    }

    // Then load files as normal
    const response = await fetch(`/api/user-files?userId=${encodeURIComponent(props.userId)}`, {
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
    
    // Load indexed files from user document (single source of truth)
    // Do NOT derive from userFiles - that creates a mismatch with server state
    if (result.indexedFiles && Array.isArray(result.indexedFiles)) {
      indexedFiles.value = result.indexedFiles;
      console.log('[KB Files] Loaded indexedFiles from server:', indexedFiles.value);
    } else {
      // If server doesn't provide indexedFiles, initialize as empty array
      // This indicates files haven't been indexed yet, not that they should match userFiles
      indexedFiles.value = [];
      console.log('[KB Files] No indexedFiles from server - initializing as empty (files not indexed yet)');
    }
  } catch (err) {
    filesError.value = err instanceof Error ? err.message : 'Failed to load files';
  } finally {
    loadingFiles.value = false;
  }
};

// const _toggleKnowledgeBase = async (file: UserFile) => {
//   updatingFiles.value.add(file.bucketKey);
//
//   try {
//     const response = await fetch('/api/toggle-file-knowledge-base', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json'
//       },
//       credentials: 'include',
//       body: JSON.stringify({
//         userId: props.userId,
//         bucketKey: file.bucketKey,
//         inKnowledgeBase: file.inKnowledgeBase
//       })
//     });
//
//     if (!response.ok) {
//       throw new Error('Failed to update knowledge base status');
//     }
//
//     // Reload files to get updated state
//     await loadFiles();
//   } catch (err) {
//     filesError.value = err instanceof Error ? err.message : 'Failed to update knowledge base status';
//     // Revert checkbox on error
//     file.inKnowledgeBase = !file.inKnowledgeBase;
//   } finally {
//     updatingFiles.value.delete(file.bucketKey);
//   }
// };

const loadAgent = async () => {
  loadingAgent.value = true;
  agentError.value = '';

  try {
    const response = await fetch(`/api/agent-instructions?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch agent: ${response.statusText}`);
    }
    const result = await response.json();
    agentInstructions.value = result.instructions || '';
    editedInstructions.value = result.instructions || '';
    kbInfo.value = result.kbInfo || null;
    
    // Load deep link Private AI access setting
    await loadDeepLinkPrivateAISetting();
  } catch (err) {
    agentError.value = err instanceof Error ? err.message : 'Failed to load agent';
  } finally {
    loadingAgent.value = false;
  }
};

const loadDeepLinkPrivateAISetting = async () => {
  try {
    const response = await fetch(`/api/user-settings?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (response.ok) {
      const result = await response.json();
      // Default to true if not set (backward compatibility)
      allowDeepLinkPrivateAI.value = result.allowDeepLinkPrivateAI !== undefined ? result.allowDeepLinkPrivateAI : true;
    }
  } catch (err) {
    // If endpoint doesn't exist yet or fails, default to true
    console.warn('Failed to load deep link setting, defaulting to enabled:', err);
    allowDeepLinkPrivateAI.value = true;
  }
};

const saveDeepLinkPrivateAISetting = async () => {
  savingDeepLinkSetting.value = true;
  try {
    const response = await fetch('/api/user-settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        allowDeepLinkPrivateAI: allowDeepLinkPrivateAI.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save setting');
    }

    // Show notification
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: allowDeepLinkPrivateAI.value 
          ? 'Deep link users can now access your Private AI' 
          : 'Deep link users can no longer access your Private AI',
        timeout: 3000
      });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to save setting';
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: errorMsg,
        timeout: 3000
      });
    }
    // Revert on error
    allowDeepLinkPrivateAI.value = !allowDeepLinkPrivateAI.value;
  } finally {
    savingDeepLinkSetting.value = false;
  }
};

const saveInstructions = async () => {
  savingInstructions.value = true;

  try {
    const response = await fetch('/api/agent-instructions', {
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

// Format relative time (minutes, hours, days ago)
const formatRelativeTime = (dateString: string | null): string => {
  if (!dateString) return 'Never';
  
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
};

// Toggle KB connection
const toggleKBConnection = async () => {
  if (!kbInfo.value || togglingKB.value) return;
  
  togglingKB.value = true;
  try {
    const action = kbInfo.value.connected ? 'detach' : 'attach';
    const response = await fetch('/api/toggle-kb-connection', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        action: action
      })
    });

    if (!response.ok) {
      throw new Error('Failed to toggle KB connection');
    }

    const result = await response.json();
    
    // Reload agent info to get updated KB connection status and other info
    await loadAgent();
    
    // Show notification
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: result.message || `KB ${action === 'attach' ? 'attached' : 'detached'} successfully`,
        timeout: 3000
      });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to toggle KB connection';
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: errorMsg,
        timeout: 5000
      });
    }
  } finally {
    togglingKB.value = false;
  }
};

// Get file names from indexed files (extract from bucketKey) - computed property for performance
const indexedFileNames = computed((): string[] => {
  if (!kbInfo.value || !kbInfo.value.indexedFiles) {
    return [];
  }
  
  return kbInfo.value.indexedFiles.map(bucketKey => {
    // Extract filename from bucketKey (format: userId/kbName/filename or userId/archived/filename)
    const parts = bucketKey.split('/');
    return parts[parts.length - 1] || bucketKey;
  });
});

const loadSharedChats = async () => {
  loadingChats.value = true;
  chatsError.value = '';

  try {
    const response = await fetch(`/api/shared-group-chats?userId=${encodeURIComponent(props.userId)}`, {
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
    const response = await fetch('/api/toggle-file-knowledge-base', {
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
    
    // Update original files to reflect the change (but don't update indexed files - that happens after indexing)
    const originalIndex = originalFiles.value.findIndex(f => f.bucketKey === oldBucketKey || f.bucketKey === result.newBucketKey);
    if (originalIndex >= 0) {
      originalFiles.value[originalIndex].inKnowledgeBase = newStatus;
      if (result.newBucketKey) {
        originalFiles.value[originalIndex].bucketKey = result.newBucketKey;
      }
    }
    
    // Note: indexedFiles is NOT updated here - it will be updated when indexing completes
    // This ensures kbIndexingOutOfSync will detect the mismatch
    
    console.log(`[KB Management] ✅ File ${file.fileName} successfully ${newStatus ? 'added to' : 'removed from'} knowledge base`);
  } catch (err) {
    console.error(`[KB Management] ❌ Error toggling file ${file.fileName}:`, err);
    // Revert checkbox on error
    file.inKnowledgeBase = !newStatus;
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to update knowledge base status'
    });
    }
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
    const response = await fetch(`/api/delete-file`, {
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
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'File deleted successfully'
    });
    }
  } catch (err) {
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to delete file'
    });
    }
  }
};

const updateAndIndexKB = async () => {
  console.log('[KB] Update and Index KB button clicked');
  indexingKB.value = true;
  indexingStatus.value = {
    phase: 'moving',
    message: 'Moving files to knowledge base folder...',
    kb: '',
    tokens: '',
    filesIndexed: 0,
    progress: 0,
    error: ''
  };

  try {
    console.log('[KB] kbIndexingOutOfSync:', kbIndexingOutOfSync.value);
    console.log('[KB] hasCheckboxChanges:', hasCheckboxChanges.value);
    
    // Files are already moved by checkboxes - no need to send changes array
    // Phase 1: KB Setup (no longer moving files)
    indexingStatus.value.phase = 'kb_setup';
    indexingStatus.value.message = 'Setting up knowledge base...';

    console.log('[KB] Calling /api/update-knowledge-base with userId:', props.userId);

    const response = await fetch('/api/update-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });

    console.log('[KB] Response status:', response.status, response.statusText);

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = { message: `HTTP ${response.status}: ${response.statusText}` };
      }
      console.error('[KB] Error response:', errorData);
      throw new Error(errorData.message || `Failed to update knowledge base: ${response.status}`);
    }

    const result = await response.json();
    console.log('[KB] Response result:', result);
    
    // Update original files
    originalFiles.value = JSON.parse(JSON.stringify(userFiles.value));
    
    // If jobId is returned, start polling
    if (result.jobId) {
      currentIndexingJobId.value = result.jobId;
      // Update phase based on response
      indexingStatus.value.phase = result.phase || 'indexing_started';
      indexingStatus.value.message = result.phase === 'indexing_started' 
        ? 'Indexing job started... This may take several minutes'
        : 'Setting up knowledge base...';
      indexingStatus.value.kb = result.kbId || result.kb || '';
      
      console.log('[KB] Starting to poll for job:', result.jobId);
      
      // Start polling for status
      pollIndexingProgress(result.jobId);
    } else if (result.error === 'INDEXING_ALREADY_RUNNING') {
      // KB already has an indexing job running - check if we can get the job ID
      console.log('[KB] Indexing already running:', result.message);
      if (result.kbId) {
        // Try to get the existing job ID from user document
        // For now, show a message and suggest waiting
        indexingKB.value = false;
        indexingStatus.value.phase = 'error';
        indexingStatus.value.error = result.message || 'Indexing job already running';
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'warning',
            message: 'Indexing already in progress. Please wait for it to complete.',
            timeout: 5000
          });
        } else {
          alert('Indexing already in progress. Please wait for it to complete.');
        }
      } else {
        throw new Error(result.message || 'Indexing job already running');
      }
    } else if (result.kbId && result.success) {
      // KB was created but jobId is null - indexing should start automatically
      // Poll for the job ID to appear
      console.log('[KB] KB created but no jobId yet. Polling for indexing job to appear...');
      indexingKB.value = true;
      indexingStatus.value.phase = 'indexing_started';
      indexingStatus.value.message = 'Knowledge base created. Waiting for indexing to start...';
      indexingStatus.value.kb = result.kbId;
      
      // Poll for job ID (up to 10 attempts with 3 second delays = 30 seconds max)
      let foundJobId = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        try {
          // Check user status to see if job ID is available
          const statusResponse = await fetch(`/api/user-status?userId=${props.userId}`, {
            method: 'GET',
            credentials: 'include'
          });
          
          if (statusResponse.ok) {
            const statusData = await statusResponse.json();
            if (statusData.kbLastIndexingJobId) {
              foundJobId = statusData.kbLastIndexingJobId;
              console.log(`[KB] Found job ID after polling: ${foundJobId} (attempt ${attempt + 1})`);
              break;
            }
          }
        } catch (pollError) {
          console.log(`[KB] Polling attempt ${attempt + 1} failed:`, pollError);
        }
      }
      
      if (foundJobId) {
        // Found job ID - start polling for progress
        currentIndexingJobId.value = foundJobId;
        console.log('[KB] Starting to poll for job:', foundJobId);
        pollIndexingProgress(foundJobId);
      } else {
        // Still no job ID after polling - show message but don't error
        console.log('[KB] Could not find job ID after polling. Indexing should start automatically.');
        indexingKB.value = false;
        indexingStatus.value.phase = 'complete';
        indexingStatus.value.message = 'Knowledge base created. Indexing will start automatically - please check back in a moment.';
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'info',
            message: 'Knowledge base created. Indexing will start automatically - please check back in a moment.',
            timeout: 5000
          });
        }
        // Reload files to show updated state
        await loadFiles();
        await loadAgent();
      }
    } else {
      // No job ID and no KB ID - something went wrong
      console.error('[KB] No jobId or kbId in response:', result);
      indexingKB.value = false;
      throw new Error('No indexing job ID returned from server');
    }
  } catch (err) {
    console.error('[KB] Error in updateAndIndexKB:', err);
    indexingKB.value = false;
    indexingStatus.value.phase = 'error';
    indexingStatus.value.error = err instanceof Error ? err.message : 'Failed to update knowledge base';
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'negative',
        message: indexingStatus.value.error,
        timeout: 5000
    });
    } else {
      // Fallback if Quasar notify is not available
      console.error('Notification error:', indexingStatus.value.error);
      alert(`Error: ${indexingStatus.value.error}`);
    }
  }
};

const resetKB = async () => {
  if (!confirm('Are you sure you want to reset the knowledge base? This will clear all KB-related data (KB ID, indexing status, indexed files) but keep the KB name and files unchanged.')) {
    return;
  }

  resettingKB.value = true;
  try {
    const response = await fetch('/api/reset-kb', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to reset KB');
    }

    const result = await response.json();
    console.log('[KB] KB reset:', result);

    // Reload files and agent info to reflect reset state
    await loadFiles();
    await loadAgent();

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Knowledge base reset successfully'
      });
    }
  } catch (err) {
    console.error('[KB] Error resetting KB:', err);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to reset KB'
      });
    } else {
      alert(`Error: ${err instanceof Error ? err.message : 'Failed to reset KB'}`);
    }
  } finally {
    resettingKB.value = false;
  }
};

const pollIndexingProgress = async (jobId: string) => {
  // Clear any existing polling interval
  if (pollingInterval.value) {
    clearInterval(pollingInterval.value);
  }
  
  // Set start time for timeout tracking
  indexingStartTime.value = Date.now();
  
  // Emit event to parent to update status tip
  emit('indexing-started', { jobId, phase: 'indexing_started' });
  
  pollingInterval.value = setInterval(async () => {
    try {
      // Check for timeout
      if (indexingStartTime.value && (Date.now() - indexingStartTime.value) > INDEXING_TIMEOUT_MS) {
        clearInterval(pollingInterval.value!);
        pollingInterval.value = null;
        indexingKB.value = false;
        indexingStatus.value.phase = 'error';
        indexingStatus.value.error = 'Indexing timed out after 30 minutes';
        emit('indexing-finished', { jobId, phase: 'error', error: 'Indexing timed out' });
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'negative',
            message: 'Indexing timed out after 30 minutes. Please check the knowledge base status.'
          });
        }
        return;
      }
      
      const response = await fetch(`/api/kb-indexing-status/${jobId}?userId=${encodeURIComponent(props.userId)}`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error(`Failed to get indexing status: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      console.log(`[KB Polling] Status check for job ${jobId}:`, {
        phase: result.phase,
        status: result.status,
        completed: result.completed,
        tokens: result.tokens,
        filesIndexed: result.filesIndexed,
        progress: result.progress
      });
      
      // Update status with all fields from response
      indexingStatus.value = {
        phase: result.phase || indexingStatus.value.phase,
        message: result.message || indexingStatus.value.message,
        kb: result.kb || indexingStatus.value.kb,
        tokens: result.tokens || indexingStatus.value.tokens || '0',
        filesIndexed: result.filesIndexed || 0,
        progress: result.progress || 0,
        error: result.error || ''
      };
      
      // Emit status update to parent for status tip
      emit('indexing-status-update', {
        jobId,
        phase: indexingStatus.value.phase,
        tokens: indexingStatus.value.tokens,
        filesIndexed: indexingStatus.value.filesIndexed,
        progress: indexingStatus.value.progress
      });

      // Handle completion - check both result.completed and result.phase
      if (result.completed || result.phase === 'complete' || result.status === 'INDEX_JOB_STATUS_COMPLETED') {
        if (pollingInterval.value !== null) {
          clearInterval(pollingInterval.value);
        }
        pollingInterval.value = null;
        
        if (result.phase === 'complete') {
          indexingStatus.value.phase = 'complete';
          indexingStatus.value.message = 'Knowledge base indexed successfully!';
          
          // Use kbIndexedFiles from server response (single source of truth)
          // Do NOT derive from userFiles - that creates a mismatch
          if (result.kbIndexedFiles && Array.isArray(result.kbIndexedFiles)) {
            indexedFiles.value = result.kbIndexedFiles;
            console.log('[KB Polling] ✅ Using kbIndexedFiles from server response:', result.kbIndexedFiles);
          } else {
            // Fallback: reload from server if not in response
            console.warn('[KB Polling] ⚠️ kbIndexedFiles not in response, reloading from server...');
        await loadFiles();
          }
          
          emit('indexing-finished', { jobId, phase: 'complete' });
          
          // Reload agent info to update KB info (including indexed files and connection status)
          if (currentTab.value === 'agent') {
            await loadAgent();
          }
          
          // Attach KB to agent and generate patient summary
          await attachKBAndGenerateSummary();
          
          // Auto-hide after 5 seconds
          setTimeout(() => {
            indexingKB.value = false;
          }, 5000);
        } else if (result.phase === 'error') {
          indexingStatus.value.phase = 'error';
          indexingStatus.value.error = result.error || 'Indexing failed';
          emit('indexing-finished', { jobId, phase: 'error', error: indexingStatus.value.error });
        $q.notify({
            type: 'negative',
            message: `Indexing failed: ${indexingStatus.value.error}`
        });
        }
      }
    } catch (err) {
      clearInterval(pollingInterval.value!);
      pollingInterval.value = null;
      indexingKB.value = false;
      indexingStatus.value.phase = 'error';
      indexingStatus.value.error = err instanceof Error ? err.message : 'Failed to get indexing status';
      emit('indexing-finished', { jobId, phase: 'error', error: indexingStatus.value.error });
      console.error('Error polling indexing status:', err);
      $q.notify({
        type: 'negative',
        message: `Error checking indexing status: ${indexingStatus.value.error}`
      });
    }
  }, 10000); // Poll every 10 seconds (changed from 2 seconds)
};

// Chat management methods
const selectChat = async (chat: SavedChat) => {
  try {
    let response;
    
    // If chat has a shareId, load it via shareId endpoint (for deep links)
    if (chat.shareId) {
      response = await fetch(`/api/load-chat-by-share/${chat.shareId}`, {
      credentials: 'include'
    });
    } else {
      // Otherwise, load chat via chatId
      response = await fetch(`/api/load-chat/${chat._id}`, {
        credentials: 'include'
      });
    }
    
    if (!response.ok) {
      throw new Error(`Failed to load chat: ${response.statusText}`);
    }
    
    const result = await response.json();
    const closed = await closeDialog();
    if (closed) {
    emit('chat-selected', result.chat);
    }
  } catch (err) {
    console.error('Failed to load full chat data:', err);
    // Fallback: emit the chat we have
    const closed = await closeDialog();
    if (closed) {
    emit('chat-selected', chat);
    }
  }
};

const copyChatLink = (chat: SavedChat) => {
  if (!chat.shareId) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'Create a deep link by saving this chat first.',
        position: 'top',
        timeout: 2000
      });
    }
    return;
  }

  const baseUrl = window.location.origin;
  const link = `${baseUrl}/chat/${chat.shareId}`;

  navigator.clipboard.writeText(link)
    .then(() => {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'positive',
          message: 'Deep link copied to clipboard',
          position: 'top',
          timeout: 3000,
          color: 'primary',
          textColor: 'white'
        });
      } else {
        alert('Deep link copied to clipboard');
      }
    })
    .catch(() => {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: 'Failed to copy link',
          position: 'top',
          timeout: 3000
        });
      } else {
        alert('Failed to copy link');
      }
    });
};

const confirmDeleteChat = (chat: SavedChat) => {
  if ($q && typeof $q.dialog === 'function') {
  $q.dialog({
    title: 'Delete Chat',
    message: 'Are you sure you want to delete this chat?',
    cancel: true,
    persistent: true
  }).onOk(() => {
    deleteChat(chat);
  });
  } else if (window.confirm('Are you sure you want to delete this chat?')) {
    deleteChat(chat);
  }
};

const deleteChat = async (chat: SavedChat) => {
  try {
    await deleteChatById(chat._id);

    // Remove from list
    sharedChats.value = sharedChats.value.filter(c => c._id !== chat._id);
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Chat deleted successfully'
    });
    }
  } catch (err) {
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to delete chat'
    });
    } else {
      console.error('Failed to delete chat:', err);
    }
  }
};

// Attach KB to agent and generate patient summary
const attachKBAndGenerateSummary = async () => {
  try {
    console.log('[KB] Attaching KB to agent and generating patient summary...');
    
    // Keep indexing status visible and update message
    indexingStatus.value.message = 'Attaching knowledge base to agent...';
    emit('indexing-status-update', {
      jobId: currentIndexingJobId.value || '',
      phase: 'kb_setup',
      tokens: indexingStatus.value.tokens,
      filesIndexed: indexingStatus.value.filesIndexed,
      progress: 1.0
    });
    
    // Step 1: Attach KB to agent
    const attachResponse = await fetch('/api/attach-kb-to-agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });

    if (!attachResponse.ok) {
      const errorData = await attachResponse.json();
      throw new Error(errorData.message || 'Failed to attach KB to agent');
    }

    const attachResult = await attachResponse.json();
    console.log('[KB] KB attached to agent:', attachResult);
    
    // Step 2: Generate patient summary
    indexingStatus.value.message = 'Generating patient summary...';
    emit('indexing-status-update', {
      jobId: currentIndexingJobId.value || '',
      phase: 'kb_setup',
      tokens: indexingStatus.value.tokens,
      filesIndexed: indexingStatus.value.filesIndexed,
      progress: 1.0
    });
    
    const summaryResponse = await fetch('/api/generate-patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });

    if (!summaryResponse.ok) {
      const errorData = await summaryResponse.json();
      throw new Error(errorData.message || 'Failed to generate patient summary');
    }

    const summaryResult = await summaryResponse.json();
    console.log('[KB] Patient summary generated:', summaryResult);
    
    // Store the new summary and show modal
    newPatientSummary.value = summaryResult.summary || '';
    showSummaryAvailableModal.value = true;
    
    // Update indexing status to show completion
    indexingStatus.value.message = 'Knowledge base indexed and patient summary generated!';
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Knowledge base indexed and patient summary generated!'
      });
    }
  } catch (error) {
    console.error('[KB] Error in attachKBAndGenerateSummary:', error);
    indexingStatus.value.message = `Error: ${error instanceof Error ? error.message : 'Failed to attach KB or generate summary'}`;
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to attach KB or generate summary'
      });
    }
  }
};

// Patient Summary modal handlers
const handleViewSummary = () => {
  summaryViewText.value = newPatientSummary.value;
  editingSummary.value = false;
  showSummaryAvailableModal.value = false;
  showSummaryViewModal.value = true;
};

const handleSaveSummary = async () => {
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: newPatientSummary.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save patient summary');
    }

    // Update local summary
    patientSummary.value = newPatientSummary.value;
    summaryEditText.value = newPatientSummary.value;
    isEditingSummaryTab.value = false;
    
    showSummaryAvailableModal.value = false;
    if (showSummaryViewModal.value) {
      showSummaryViewModal.value = false;
    }
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary'
      });
    }
  }
};

const handleCloseMyStuff = () => {
  showSummaryAvailableModal.value = false;
  emit('update:modelValue', false);
};

const handleEditSummary = () => {
  editingSummary.value = true;
};

const handleSaveEditedSummary = async () => {
  const summaryToSave = editingSummary.value ? summaryViewText.value : newPatientSummary.value;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: summaryToSave
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save patient summary');
    }

    // Update local values
    newPatientSummary.value = summaryToSave;
    patientSummary.value = summaryToSave;
    summaryEditText.value = summaryToSave;
    isEditingSummaryTab.value = false;
    editingSummary.value = false;
    showSummaryViewModal.value = false;
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary'
      });
    }
  }
};

const handleCloseWithoutSaving = () => {
  if (editingSummary.value) {
    // Revert changes
    summaryViewText.value = newPatientSummary.value;
    editingSummary.value = false;
  } else {
    showSummaryViewModal.value = false;
  }
};

// Patient Summary methods
const loadPatientSummary = async () => {
  loadingSummary.value = true;
  summaryError.value = '';

  try {
    const response = await fetch(`/api/patient-summary?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch patient summary: ${response.statusText}`);
    }
    
    const result = await response.json();
    const loadedSummary = result.summary || '';
    patientSummary.value = loadedSummary;
    summaryEditText.value = loadedSummary;
    if (!loadedSummary) {
      isEditingSummaryTab.value = false;
    }
  } catch (err) {
    summaryError.value = err instanceof Error ? err.message : 'Failed to load patient summary';
  } finally {
    loadingSummary.value = false;
  }
};

const requestNewSummary = async () => {
  // Generate a new patient summary using the agent and KB
  loadingSummary.value = true;
  summaryError.value = '';

  try {
    console.log('[Summary] Requesting new patient summary...');
    
    const response = await fetch('/api/generate-patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to generate patient summary');
    }

    const result = await response.json();
    console.log('[Summary] Patient summary generated:', result);
    
    // Update the displayed summary
    const generatedSummary = (result.summary || '').trim();
    patientSummary.value = generatedSummary;
    newPatientSummary.value = generatedSummary;
    summaryViewText.value = generatedSummary;
    summaryEditText.value = generatedSummary;
    isEditingSummaryTab.value = false;
    
    if ($q && typeof $q.notify === 'function') {
  $q.notify({
        type: 'positive',
        message: 'Patient summary generated successfully!',
        timeout: 3000
      });
    }
  } catch (error) {
    console.error('[Summary] Error generating patient summary:', error);
    summaryError.value = error instanceof Error ? error.message : 'Failed to generate patient summary';
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: summaryError.value,
        timeout: 5000
      });
    }
  } finally {
    loadingSummary.value = false;
  }
};

const startSummaryEdit = () => {
  summaryEditText.value = patientSummary.value || '';
  isEditingSummaryTab.value = true;
};

const cancelSummaryEdit = () => {
  isEditingSummaryTab.value = false;
  summaryEditText.value = '';
};

const saveSummaryFromTab = async () => {
  if (!props.userId) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'User ID is required to save the summary'
      });
    }
    return;
  }

  const summaryToSave = summaryEditText.value.trim();
  if (!summaryToSave) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'Summary cannot be empty'
      });
    }
    return;
  }

  isSavingSummary.value = true;

  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: summaryToSave
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(errorData.message || 'Failed to save patient summary');
    }

    patientSummary.value = summaryToSave;
    newPatientSummary.value = summaryToSave;
    summaryViewText.value = summaryToSave;
    summaryEditText.value = summaryToSave;
    isEditingSummaryTab.value = false;

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    console.error('[Summary] Error saving summary:', error);
    const message = error instanceof Error ? error.message : 'Failed to save patient summary';
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message
      });
    }
  } finally {
    isSavingSummary.value = false;
  }
};

const sortedSharedChats = computed(() => {
  return [...sharedChats.value].sort((a, b) => {
    const dateA = new Date(a.updatedAt || a.createdAt);
    const dateB = new Date(b.updatedAt || b.createdAt);
    return dateB.getTime() - dateA.getTime();
  });
});

const closeDialog = async (): Promise<boolean> => {
  if (hasUnsavedChanges.value) {
    const confirmClose = await new Promise<boolean>((resolve) => {
      if ($q && typeof $q.dialog === 'function') {
        $q.dialog({
          title: 'Unsaved changes',
          message: 'You have unsaved changes in My Agent or Patient Summary. Close without saving?',
          cancel: true,
          persistent: true,
          ok: {
            label: 'Discard and Close',
            color: 'negative'
          }
        }).onOk(() => resolve(true))
          .onCancel(() => resolve(false))
          .onDismiss(() => resolve(false));
      } else {
        const shouldClose = window.confirm('You have unsaved changes in My Agent or Patient Summary. Close without saving?');
        resolve(shouldClose);
      }
    });

    if (!confirmClose) {
      return false;
    }

    if (hasUnsavedAgentChanges.value) {
      cancelEdit();
    }

    if (hasUnsavedSummaryChanges.value) {
      cancelSummaryEdit();
    }
  }

  isOpen.value = false;
  return true;
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

// Clean up polling interval on component unmount
onUnmounted(() => {
  if (pollingInterval.value) {
    clearInterval(pollingInterval.value);
    pollingInterval.value = null;
  }
});
</script>

<style scoped lang="scss">
.q-item {
  cursor: default;
}
</style>
