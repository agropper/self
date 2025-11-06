<template>
  <div class="chat-interface">
    <q-card class="full-height">
      <q-card-section class="q-pa-none full-height flex column">
        <!-- File Info Bar -->
        <div v-if="uploadedFiles.length > 0" class="q-px-md q-pt-md q-pb-sm" style="flex-shrink: 0; border-bottom: 1px solid #eee;">
          <div class="row items-center q-gutter-xs">
            <q-chip
              v-for="file in uploadedFiles"
              :key="file.id"
              icon="description"
              color="primary"
              text-color="white"
              size="sm"
            >
              {{ file.name }}
              <q-btn 
                v-if="file.type === 'pdf'"
                flat dense round size="xs" 
                icon="visibility" 
                color="white"
                @click="viewFile(file)"
              />
              <q-btn 
                flat dense round size="xs" 
                icon="close" 
                color="white"
                @click="removeFile(file)"
              />
            </q-chip>
          </div>
        </div>
        
        <div v-if="isUploadingFile" class="q-px-md q-pt-sm q-pb-sm" style="flex-shrink: 0; border-bottom: 1px solid #eee;">
          <div class="text-xs text-grey-6">Uploading...</div>
        </div>

        <!-- Chat Area -->
        <div ref="chatMessagesRef" class="chat-messages q-pa-md" style="flex: 1; overflow-y: auto; min-height: 0;">
          <template v-for="(msg, idx) in messages" :key="idx">
            <!-- Normal Chat Message -->
            <div 
              v-if="!editingMessageIdx.includes(idx)"
              class="q-mb-md"
              :class="msg.role === 'user' ? 'text-right' : 'text-left'"
            >
              <q-badge 
                :color="msg.role === 'user' ? 'primary' : 'secondary'"
                :label="msg.role === 'assistant' ? getProviderLabel() : getUserLabel()"
              />
              <div 
                class="q-mt-xs q-pa-sm rounded-borders"
                :class="msg.role === 'user' ? 'bg-blue-1' : 'bg-grey-2'"
                style="display: inline-block; max-width: 80%;"
              >
                <vue-markdown :source="msg.content" />
                <div class="q-mt-sm">
                  <q-btn
                    flat
                    dense
                    size="xs"
                    icon="edit"
                    color="grey-8"
                    label="Edit"
                    @click="startEditing(idx)"
                    title="Edit message"
                  />
                </div>
              </div>
            </div>
            
            <!-- Editable Chat Message -->
            <div 
              v-if="editingMessageIdx.includes(idx)"
              class="q-mb-md"
              :class="msg.role === 'user' ? 'text-right' : 'text-left'"
            >
              <q-badge 
                :color="msg.role === 'user' ? 'primary' : 'secondary'"
                :label="msg.role === 'assistant' ? getProviderLabel() : getUserLabel()"
              />
              <div 
                class="q-mt-xs q-pa-sm rounded-borders"
                :class="msg.role === 'user' ? 'bg-blue-1' : 'bg-grey-2'"
                style="display: inline-block; max-width: 80%"
              >
                <textarea 
                  v-model="msg.content" 
                  rows="8"
                  class="full-width q-pa-sm"
                  style="border: 1px solid #ccc; border-radius: 4px; resize: vertical;"
                />
                <div class="edit-buttons q-mt-sm">
                  <q-btn
                    size="sm"
                    icon="save"
                    color="primary"
                    label="Save"
                    @click="saveEditedMessage(idx)"
                  />
                  <q-btn
                    size="sm"
                    icon="delete"
                    color="negative"
                    label="Delete Question and Response"
                    @click="confirmDeleteMessage(idx)"
                  />
                </div>
              </div>
            </div>
          </template>
          
          <div v-if="isStreaming" class="text-grey-6">
            Thinking... <q-spinner-dots size="sm" />
          </div>
        </div>
        
        <!-- Delete Confirmation Dialog -->
        <q-dialog v-model="showDeleteDialog" persistent>
          <q-card style="min-width: 350px">
            <q-card-section>
              <div class="text-h6">Delete Messages</div>
            </q-card-section>

            <q-card-section>
              <div class="text-body1">
                <p>Are you sure you want to delete this message?</p>
                <div class="message-preview q-mt-md">
                  <strong>{{ messageToDelete?.role === 'user' ? getUserLabel() : getProviderLabel() }}:</strong>
                  <div class="message-content">{{ messageToDelete?.content?.substring(0, 100) }}{{ messageToDelete?.content?.length > 100 ? '...' : '' }}</div>
                </div>
                <p v-if="precedingUserMessage" class="text-caption text-grey q-mt-sm">
                  <strong>Note:</strong> This will also delete the preceding user question.
                </p>
              </div>
            </q-card-section>

            <q-card-actions align="right">
              <q-btn flat label="Cancel" color="primary" @click="showDeleteDialog = false" />
              <q-btn flat label="Delete" color="negative" @click="deleteMessageConfirmed" />
            </q-card-actions>
          </q-card>
        </q-dialog>

        <!-- Input Area with Provider Selector -->
        <div class="q-pa-md" style="flex-shrink: 0; border-top: 1px solid #eee;">
          <!-- Save Buttons -->
          <div class="row q-gutter-sm q-mb-sm" v-if="messages.length > 0">
            <div class="col"></div>
            <div class="col-auto">
              <q-btn 
                flat 
                dense 
                size="sm"
                color="primary" 
                label="SAVE LOCALLY"
                icon="save"
                @click="saveLocally"
                :disable="isStreaming || !hasChatChanged"
              />
              <q-btn 
                flat 
                dense 
                size="sm"
                color="secondary" 
                label="SAVE TO GROUP"
                icon="group"
                @click="saveToGroup"
                :disable="isStreaming || !hasChatChanged"
              />
              <q-btn 
                flat 
                dense 
                size="sm"
                color="primary" 
                :label="`${savedChatCount} SAVED CHATS`"
                icon="history"
                @click="showSavedChats"
                :disable="!props.user?.userId"
              />
            </div>
          </div>
          
          <div class="row q-gutter-sm">
            <div class="col-auto">
              <q-select
                v-model="selectedProvider"
                :options="providerOptions"
                dense
                outlined
                style="min-width: 150px"
              >
                <q-tooltip>Select AI provider: Private AI uses your knowledge base, Public AIs see only chat content</q-tooltip>
              </q-select>
            </div>
            <div class="col">
              <q-input
                v-model="inputMessage"
                label="Type your message"
                outlined
                dense
                @keyup.enter="sendMessage"
              >
                <q-tooltip>Ask for Patient Summary to add it to the chat context and make it available to public AIs.</q-tooltip>
              </q-input>
            </div>
            <div class="col-auto">
              <q-btn 
                color="primary" 
                label="Send"
                :disable="!inputMessage || isStreaming"
                @click="sendMessage"
              />
            </div>
          </div>
          
          <!-- Status Bar -->
          <div class="row q-gutter-sm q-mt-sm q-pt-sm" style="border-top: 1px solid #eee; align-items: center;">
            <div class="col-auto">
              <q-btn 
                flat 
                dense 
                round 
                icon="attach_file" 
                class="text-grey-6" 
                @click="triggerFileInput"
              >
                <q-tooltip>Attach files to add them to the chat context</q-tooltip>
              </q-btn>
              <input
                ref="fileInput"
                type="file"
                style="display: none"
                @change="handleFileSelect"
              />
            </div>
            <div class="col" style="display: flex; align-items: center; justify-content: center;">
              <q-btn 
                flat 
                dense 
                round 
                icon="settings" 
                class="text-grey-6 q-mr-xs" 
                @click="showMyStuffDialog = true"
              >
                <q-tooltip>My Stuff: Manage files, knowledge base, agent settings, and patient summary</q-tooltip>
              </q-btn>
              <span class="text-body2 text-grey-7" :title="contextualTip">{{ contextualTip }}</span>
            </div>
            <div class="col-auto" style="display: flex; align-items: center; justify-content: flex-end; gap: 8px;">
              <span class="text-body2 text-grey-7">User: {{ props.user?.userId || 'Guest' }}</span>
              <q-btn flat dense label="SIGN OUT" color="grey-8" @click="handleSignOut" />
              <q-btn 
                flat 
                dense 
                round 
                icon="email" 
                class="text-grey-6" 
                @click="openAdminEmail"
              >
                <q-tooltip anchor="top left" self="bottom right">Email admin for suggestions, support or questions</q-tooltip>
              </q-btn>
            </div>
          </div>
        </div>
      </q-card-section>
    </q-card>

    <!-- PDF Viewer Modal -->
    <PdfViewerModal
      v-model="showPdfViewer"
      :file="viewingFile"
    />

    <!-- Saved Chats Modal -->
    <SavedChatsModal
      v-model="showSavedChatsModal"
      :currentUser="props.user?.userId || ''"
      @chat-selected="handleChatSelected"
    />

    <!-- My Stuff Dialog -->
    <MyStuffDialog
      v-model="showMyStuffDialog"
      :userId="props.user?.userId || ''"
      @chat-selected="handleChatSelected"
      @indexing-started="handleIndexingStarted"
      @indexing-status-update="handleIndexingStatusUpdate"
      @indexing-finished="handleIndexingFinished"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watch, nextTick } from 'vue';
import PdfViewerModal from './PdfViewerModal.vue';
import SavedChatsModal from './SavedChatsModal.vue';
import MyStuffDialog from './MyStuffDialog.vue';
import html2pdf from 'html2pdf.js';
import VueMarkdown from 'vue-markdown-render';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  name?: string;
}

interface User {
  userId: string;
  displayName: string;
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: 'text' | 'pdf' | 'markdown';
  content: string;
  transcript?: string;
  originalFile: File;
  bucketKey?: string;
  bucketPath?: string;
  fileUrl?: string;
  uploadedAt: Date;
}

interface Props {
  user?: User | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'sign-out': [];
}>();

const providers = ref<string[]>([]);
const selectedProvider = ref<string>('Private AI');
const messages = ref<Message[]>([]);
const inputMessage = ref('');
const isStreaming = ref(false);
const uploadedFiles = ref<UploadedFile[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const isUploadingFile = ref(false);
const showPdfViewer = ref(false);
const viewingFile = ref<UploadedFile | null>(null);
const showSavedChatsModal = ref(false);
const savedChatCount = ref(0);
const showMyStuffDialog = ref(false);
const contextualTip = ref('Loading...');
const editingMessageIdx = ref<number[]>([]);
const showDeleteDialog = ref(false);
const messageToDelete = ref<Message | null>(null);
const precedingUserMessage = ref<Message | null>(null);
const chatMessagesRef = ref<HTMLElement | null>(null);

// Track initial chat state for change detection
const initialMessages = ref<Message[]>([]);
const initialUploadedFiles = ref<UploadedFile[]>([]);

// Computed property to check if chat has changed
const hasChatChanged = computed(() => {
  if (messages.value.length !== initialMessages.value.length) {
    return true;
  }
  
  // Compare messages
  for (let i = 0; i < messages.value.length; i++) {
    const current = messages.value[i];
    const initial = initialMessages.value[i];
    if (!initial || current.role !== initial.role || current.content !== initial.content) {
      return true;
    }
  }
  
  // Compare uploaded files
  if (uploadedFiles.value.length !== initialUploadedFiles.value.length) {
    return true;
  }
  
  for (let i = 0; i < uploadedFiles.value.length; i++) {
    const current = uploadedFiles.value[i];
    const initial = initialUploadedFiles.value[i];
    if (!initial || current.id !== initial.id) {
      return true;
    }
  }
  
  return false;
});

// Provider labels map
const providerLabels: Record<string, string> = {
  digitalocean: 'Private AI',
  anthropic: 'Anthropic',
  openai: 'ChatGPT',
  gemini: 'Gemini',
  deepseek: 'DeepSeek'
};

// Computed provider options for dropdown
const providerOptions = computed(() => {
  return providers.value.map(p => providerLabels[p] || p.charAt(0).toUpperCase() + p.slice(1));
});

// Helper to get provider key from label
const getProviderKey = (label: string) => {
  const entry = Object.entries(providerLabels).find(([_, l]) => l === label);
  return entry ? entry[0] : label.toLowerCase();
};

// Helper functions for labels
const getUserLabel = () => {
  return props.user?.userId || 'You';
};

const getProviderLabel = () => {
  return providerLabels[selectedProvider.value] || selectedProvider.value;
};

// Fetch available providers
const loadProviders = async () => {
  try {
    const response = await fetch('http://localhost:3001/api/chat/providers');
    const data = await response.json();
    providers.value = data.providers;
    if (providers.value.length > 0) {
      // Set to the first provider's label
      selectedProvider.value = providerLabels[providers.value[0]] || providers.value[0];
    }
  } catch (error) {
    console.error('Failed to load providers:', error);
    // Fallback for development
    providers.value = ['digitalocean', 'anthropic'];
    selectedProvider.value = providerLabels['digitalocean'] || 'Private AI';
  }
};

// Token estimation helper
const estimateTokenCount = (text: string) => {
  const averageTokenLength = 2.75;
  return Math.ceil((text.length / averageTokenLength) * 1.15);
};

// Send message (streaming)
const sendMessage = async () => {
  if (!inputMessage.value || isStreaming.value) return;

  const startTime = Date.now();

  const userMessage: Message = {
    role: 'user',
    content: inputMessage.value,
    name: getUserLabel()
  };

  // Check if this is a patient summary request
  const isPatientSummaryRequest = /patient\s+summary/i.test(inputMessage.value);
  messages.value.push(userMessage);
  inputMessage.value = '';
  // Don't update initialMessages here - wait until after save
  
  isStreaming.value = true;

  try {
    // If this is a patient summary request, check for existing summary first
    if (isPatientSummaryRequest && props.user?.userId) {
      try {
        const summaryResponse = await fetch(`http://localhost:3001/api/patient-summary?userId=${encodeURIComponent(props.user.userId)}`, {
          credentials: 'include'
        });
        
        if (summaryResponse.ok) {
          const summaryData = await summaryResponse.json();
          if (summaryData.summary && summaryData.summary.trim()) {
            // Use existing summary
            messages.value.push({
              role: 'assistant',
              content: summaryData.summary,
              name: getProviderLabel()
            });
            isStreaming.value = false;
            return;
          }
        }
      } catch (err) {
        // If fetching summary fails, continue with normal chat flow
        console.log('Could not fetch existing summary, generating new one:', err);
      }
    }
    // Build messages with file context
    const messagesWithContext = uploadedFiles.value.length > 0
      ? messages.value.map((msg, index) => {
          // Add file context to the last user message
          if (index === messages.value.length - 1 && msg.role === 'user') {
            const filesContext = uploadedFiles.value.map(file => 
              `File: ${file.name} (${file.type})\nContent:\n${file.type === 'pdf' ? file.content : file.content}`
            ).join('\n\n');
            return {
              ...msg,
              content: `${filesContext}\n\nUser query: ${msg.content}`
            };
          }
          return msg;
        })
      : messages.value;
    
    // Calculate tokens and context size for logging
    const allMessagesText = messagesWithContext.map(msg => msg.content).join('\n');
    const totalTokens = estimateTokenCount(allMessagesText);
    const contextSizeKB = Math.round(allMessagesText.length / 1024 * 100) / 100;
    const uploadedFilesCount = uploadedFiles.value.length;
    
    // Calculate just the file context for additional logging
    const filesContextText = uploadedFiles.value.map(file => 
      `File: ${file.name} (${file.type})\nContent:\n${file.type === 'pdf' ? file.content : file.content}`
    ).join('\n\n');
    const filesTokens = estimateTokenCount(filesContextText);
    const filesSizeKB = Math.round(filesContextText.length / 1024 * 100) / 100;
    
    console.log(`[*] AI Query: ${totalTokens} tokens (${filesTokens} from files), ${contextSizeKB}KB context (${filesSizeKB}KB files), ${uploadedFilesCount} files`);
    
    // Convert displayed label to API key
    const providerKey = getProviderKey(selectedProvider.value);
    const response = await fetch(
      `http://localhost:3001/api/chat/${providerKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        credentials: 'include', // Include session cookie
        body: JSON.stringify({
          messages: messagesWithContext,
          options: {
            stream: true
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw { message: errorData.error || `HTTP ${response.status}`, status: response.status };
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    // Create assistant message
    const assistantMessage: Message = {
      role: 'assistant',
      content: '',
      name: getProviderLabel()
    };
    messages.value.push(assistantMessage);

    // Read stream
    while (true) {
      const { done, value } = await reader!.read();
      
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            
            if (data.delta) {
              assistantMessage.content += data.delta;
            }
            
            if (data.isComplete) {
              isStreaming.value = false;
              const responseTime = Date.now() - startTime;
              console.log(`[*] AI Response time: ${responseTime}ms`);
              
              // Save patient summary if this was a summary request
              if (isPatientSummaryRequest && props.user?.userId && assistantMessage.content) {
                savePatientSummary(assistantMessage.content);
              }
              
              return;
            }
          } catch (e) {
            // Skip malformed JSON
          }
        }
      }
    }

    isStreaming.value = false;
    const responseTime = Date.now() - startTime;
    console.log(`[*] AI Response time: ${responseTime}ms`);
    
    // Save patient summary if this was a summary request
    if (isPatientSummaryRequest && props.user?.userId && assistantMessage.content) {
      savePatientSummary(assistantMessage.content);
    }
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error('Chat error:', error);
    console.log(`[*] AI Response time: ${responseTime}ms (failed)`);
    
    // Build error message
    let errorMessage = '';
    if (typeof error === 'object' && error !== null && 'status' in error) {
      errorMessage = error.message || 'Failed to get response';
      
      // Add special message for 429 rate limit errors
      if (error.status === 429) {
        errorMessage += `\n\n**Your Private AI may be able to handle larger contexts than the ${getProviderLabel()} model.**`;
      }
    } else if (error instanceof Error) {
      errorMessage = error.message;
    } else {
      errorMessage = 'Failed to get response';
    }
    
    messages.value.push({
      role: 'assistant',
      content: `Error: ${errorMessage}`,
      name: getProviderLabel()
    });
    isStreaming.value = false;
  }
};

const handleSignOut = () => {
  emit('sign-out');
};

const openAdminEmail = async () => {
  try {
    // Try to get admin email from server
    const response = await fetch('http://localhost:3001/api/admin-email', {
      credentials: 'include'
    });
    let adminEmail = 'admin@yourdomain.com'; // Default fallback
    if (response.ok) {
      const data = await response.json();
      adminEmail = data.email || adminEmail;
    }
    
    const subject = encodeURIComponent(`Question from ${props.user?.userId || 'User'}`);
    const body = encodeURIComponent(`Hello,\n\nI have a question about my MAIA account.\n\nThank you!`);
    window.location.href = `mailto:${adminEmail}?subject=${subject}&body=${body}`;
  } catch (error) {
    // Fallback to default email if endpoint fails
    const adminEmail = 'admin@yourdomain.com';
    const subject = encodeURIComponent(`Question from ${props.user?.userId || 'User'}`);
    const body = encodeURIComponent(`Hello,\n\nI have a question about my MAIA account.\n\nThank you!`);
    window.location.href = `mailto:${adminEmail}?subject=${subject}&body=${body}`;
  }
};

const savePatientSummary = async (summary: string) => {
  if (!props.user?.userId || !summary) return;
  
  try {
    const response = await fetch('http://localhost:3001/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.user.userId,
        summary: summary
      })
    });
    
    if (response.ok) {
      console.log('Patient summary saved successfully');
    } else {
      console.error('Failed to save patient summary');
    }
  } catch (error) {
    console.error('Error saving patient summary:', error);
  }
};

const triggerFileInput = () => {
  fileInput.value?.click();
};

const handleFileSelect = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  
  if (!file) return;

  isUploadingFile.value = true;

  try {
    // Detect file type
    const fileType = detectFileType(file.name, file.type);
    
    if (fileType === 'pdf') {
      await uploadPDFFile(file);
    } else if (fileType === 'text' || fileType === 'markdown') {
      await uploadTextFile(file);
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error('Error uploading file:', error);
    alert(`Error uploading file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    isUploadingFile.value = false;
  }
};

const detectFileType = (fileName: string, mimeType: string): 'text' | 'pdf' | 'markdown' => {
  const ext = fileName.toLowerCase().split('.').pop();
  
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    return 'pdf';
  }
  
  if (ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }
  
  return 'text';
};

const uploadPDFFile = async (file: File) => {
  // Check file size
  const maxSize = 50 * 1024 * 1024; // 50MB
  if (file.size > maxSize) {
    throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 50MB.`);
  }

  // Parse PDF on server
  const formData = new FormData();
  formData.append('pdfFile', file);
  
  const parseResponse = await fetch('http://localhost:3001/api/files/parse-pdf', {
    method: 'POST',
    body: formData
  });

  if (!parseResponse.ok) {
    const errorData = await parseResponse.json();
    throw new Error(errorData.error || 'Failed to parse PDF');
  }

  const parseResult = await parseResponse.json();
  
  console.log(`[*] PDF parsed: ${file.name}, ${file.size} bytes → ${parseResult.text.length} chars (${parseResult.pages} pages)`);

  // Upload to bucket
  const uploadFormData = new FormData();
  uploadFormData.append('file', file);

  const uploadResponse = await fetch('http://localhost:3001/api/files/upload', {
    method: 'POST',
    credentials: 'include',
    body: uploadFormData
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json();
    throw new Error(errorData.error || 'Failed to upload file');
  }

  const uploadResult = await uploadResponse.json();

  // Update user document with file metadata
  if (props.user?.userId) {
    try {
      await fetch('http://localhost:3001/api/user-file-metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          userId: props.user.userId,
          fileMetadata: {
            fileName: uploadResult.fileInfo.fileName,
            bucketKey: uploadResult.fileInfo.bucketKey,
            bucketPath: uploadResult.fileInfo.userFolder,
            fileSize: uploadResult.fileInfo.size,
            fileType: 'pdf',
            uploadedAt: uploadResult.fileInfo.uploadedAt
          }
        })
      });
    } catch (error) {
      console.warn('Failed to save file metadata to user document:', error);
    }
  }

  // Create uploaded file object
  const uploadedFile: UploadedFile = {
    id: `file-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    name: file.name,
    size: file.size,
    type: 'pdf',
    content: parseResult.text,
    originalFile: file,
    bucketKey: uploadResult.fileInfo.bucketKey,
    bucketPath: uploadResult.fileInfo.userFolder,
    fileUrl: uploadResult.fileInfo.fileUrl,
    uploadedAt: new Date()
  };

  uploadedFiles.value.push(uploadedFile);
};

const uploadTextFile = async (file: File) => {
  const text = await readFileAsText(file);
  
  const uploadedFile: UploadedFile = {
    id: `file-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    name: file.name,
    size: file.size,
    type: file.name.endsWith('.md') ? 'markdown' : 'text',
    content: text,
    originalFile: file,
    uploadedAt: new Date()
  };

  uploadedFiles.value.push(uploadedFile);
};

const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
};

const viewFile = (file: UploadedFile) => {
  viewingFile.value = file;
  showPdfViewer.value = true;
};

const removeFile = (file: UploadedFile) => {
  const index = uploadedFiles.value.findIndex(f => f.id === file.id);
  if (index !== -1) {
    uploadedFiles.value.splice(index, 1);
  }
};

const saveLocally = async () => {
  try {
    // Get the chat area element to capture (including file chips)
    const chatAreaElement = document.querySelector('.chat-interface');
    
    if (!chatAreaElement) {
      alert('Chat area not found');
      return;
    }
    
    // Generate filename with date and time (HH:MM format)
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day} ${hours}:${minutes}`;
    const filename = `MAIA chat ${dateStr}.pdf`;
    
    // Try to use File System Access API to save to MAIA folder
    // @ts-ignore - File System Access API types not in TypeScript
    if ('showSaveFilePicker' in window) {
      try {
        // @ts-ignore
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: 'PDF files',
            accept: { 'application/pdf': ['.pdf'] }
          }]
        });
        
        // Generate PDF as blob
        const blob = await html2pdf().from(chatAreaElement).output('blob');
        
        // Write to file
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        
        alert('Chat saved successfully!');
        // Reset initial state after save
        initialMessages.value = JSON.parse(JSON.stringify(messages.value));
        initialUploadedFiles.value = JSON.parse(JSON.stringify(uploadedFiles.value));
        return;
      } catch (err: any) {
        // User cancelled or error - fall through to regular download
        if (err.name !== 'AbortError') {
          console.error('File System Access API error:', err);
        }
      }
    }
    
    // Fallback: Regular download
    const opt = {
      margin: 0.5,
      filename: filename,
      image: { 
        type: 'jpeg', 
        quality: 0.98 
      },
      html2canvas: { 
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: false
      },
      jsPDF: { 
        unit: 'in', 
        format: 'a4', 
        orientation: 'portrait' 
      }
    };
    
    // Generate and save PDF
    await html2pdf().from(chatAreaElement).set(opt).save();
    
    alert('Chat saved successfully!');
    // Reset initial state after save
    initialMessages.value = JSON.parse(JSON.stringify(messages.value));
    initialUploadedFiles.value = JSON.parse(JSON.stringify(uploadedFiles.value));
  } catch (error) {
    console.error('Error saving chat:', error);
    alert(`Failed to save chat: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const saveToGroup = async () => {
  try {
    if (!props.user?.userId) {
      alert('You must be logged in to save chats to a group');
      return;
    }

    const response = await fetch('http://localhost:3001/api/save-group-chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chatHistory: messages.value,
        uploadedFiles: uploadedFiles.value,
        currentUser: props.user.userId,
        connectedKB: getProviderKey(selectedProvider.value)
      }),
      credentials: 'include'
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to save chat');
    }

    const result = await response.json();
    
    alert(`Chat saved successfully! Share ID: ${result.shareId}`);
    
    // Refresh the saved chat count
    loadSavedChatCount();
    // Reset initial state after save
    initialMessages.value = JSON.parse(JSON.stringify(messages.value));
    initialUploadedFiles.value = JSON.parse(JSON.stringify(uploadedFiles.value));
  } catch (error) {
    console.error('Error saving to group:', error);
    alert(`Failed to save chat: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const showSavedChats = () => {
  showSavedChatsModal.value = true;
  loadSavedChatCount();
};

const loadSavedChatCount = async () => {
  if (!props.user?.userId) return;
  
  try {
    const response = await fetch(`http://localhost:3001/api/user-chats?userId=${encodeURIComponent(props.user.userId)}`);
    if (response.ok) {
      const result = await response.json();
      savedChatCount.value = result.count || 0;
    }
  } catch (error) {
    console.error('Failed to load chat count:', error);
  }
};

const handleChatSelected = (chat: any) => {
  // Load the chat history
  if (chat.chatHistory) {
    messages.value = chat.chatHistory;
    // Update initial state after loading chat
    initialMessages.value = JSON.parse(JSON.stringify(chat.chatHistory));
  }
  
  // Load the uploaded files
  if (chat.uploadedFiles) {
    uploadedFiles.value = chat.uploadedFiles.map((file: any) => ({
      id: file.id || `file-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      name: file.name,
      size: file.size,
      type: file.type,
      content: '', // Content not saved to reduce size
      originalFile: null as any,
      bucketKey: file.bucketKey,
      bucketPath: file.bucketPath,
      uploadedAt: file.uploadedAt ? new Date(file.uploadedAt) : new Date()
    }));
    // Update initial state after loading files
    initialUploadedFiles.value = JSON.parse(JSON.stringify(uploadedFiles.value));
  } else {
    uploadedFiles.value = [];
    initialUploadedFiles.value = [];
  }
};

// Reset initial state when chat is cleared
const clearChat = () => {
  messages.value = [];
  uploadedFiles.value = [];
  initialMessages.value = [];
  initialUploadedFiles.value = [];
};

const startEditing = (idx: number) => {
  if (!editingMessageIdx.value.includes(idx)) {
    editingMessageIdx.value.push(idx);
  }
};

const saveEditedMessage = (idx: number) => {
  const editIndex = editingMessageIdx.value.indexOf(idx);
  if (editIndex > -1) {
    editingMessageIdx.value.splice(editIndex, 1);
  }
};

const confirmDeleteMessage = (idx: number) => {
  const message = messages.value[idx];
  messageToDelete.value = message;
  
  // Check if deleting an assistant message with a preceding user message
  if (message.role === 'assistant' && idx > 0 && messages.value[idx - 1].role === 'user') {
    precedingUserMessage.value = messages.value[idx - 1];
  } else {
    precedingUserMessage.value = null;
  }
  
  showDeleteDialog.value = true;
};

const deleteMessageConfirmed = () => {
  if (!messageToDelete.value) return;
  
  const idx = messages.value.findIndex(msg => msg === messageToDelete.value);
  if (idx === -1) return;
  
  // Remove the message
  messages.value.splice(idx, 1);
  
  // If there was a preceding user message, remove it too
  if (precedingUserMessage.value && idx > 0) {
    const userIdx = idx - 1;
    if (messages.value[userIdx]?.role === 'user') {
      messages.value.splice(userIdx, 1);
    }
  }
  
  // Remove from editing if it was being edited
  const editIndex = editingMessageIdx.value.indexOf(idx);
  if (editIndex > -1) {
    editingMessageIdx.value.splice(editIndex, 1);
  }
  
  // Close modal and reset
  showDeleteDialog.value = false;
  messageToDelete.value = null;
  precedingUserMessage.value = null;
  // Don't update initialMessages here - deletion is a change that should enable save buttons
};

// Auto-scroll chat to bottom when messages change
const scrollToBottom = async () => {
  await nextTick();
  await nextTick(); // Double nextTick to ensure DOM is fully updated
  if (chatMessagesRef.value) {
    // Use setTimeout to ensure DOM has fully updated
    setTimeout(() => {
      if (chatMessagesRef.value) {
        chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight;
      }
    }, 0);
  }
};

// Watch for specific changes and trigger scroll with flush: 'post'
watch(() => [messages.value.length, messages.value[messages.value.length - 1]?.content], () => {
  scrollToBottom();
}, { flush: 'post' });

const syncAgent = async () => {
  if (!props.user?.userId) return;
  
  try {
    const response = await fetch('http://localhost:3001/api/sync-agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include'
    });
    
    if (response.ok) {
      const result = await response.json();
      if (result.success) {
        console.log('Agent synced:', result.agent?.name);
      } else {
        // No agent found - this is OK, user might not have one yet
        console.log('No agent found for user');
      }
    } else {
      console.error('Failed to sync agent:', response.status, response.statusText);
    }
  } catch (error) {
    console.error('Failed to sync agent:', error);
  }
};

// Indexing status tracking
const indexingStatus = ref<{
  active: boolean;
  phase: string;
  tokens: string;
  filesIndexed: number;
  progress: number;
} | null>(null);

const handleIndexingStarted = (data: { jobId: string; phase: string }) => {
  indexingStatus.value = {
    active: true,
    phase: data.phase,
    tokens: '0',
    filesIndexed: 0,
    progress: 0
  };
  updateContextualTip();
};

const handleIndexingStatusUpdate = (data: { jobId: string; phase: string; tokens: string; filesIndexed: number; progress: number }) => {
  if (indexingStatus.value) {
    indexingStatus.value.phase = data.phase;
    indexingStatus.value.tokens = data.tokens;
    indexingStatus.value.filesIndexed = data.filesIndexed;
    indexingStatus.value.progress = data.progress;
    updateContextualTip();
  }
};

const handleIndexingFinished = (data: { jobId: string; phase: string; error?: string }) => {
  indexingStatus.value = null;
  // Update status tip to show normal status
  updateContextualTip();
};

// Map workflow stages to user-friendly tips
const getWorkflowTip = (workflowStage: string | null): string => {
  const tips: Record<string, string> = {
    'request_sent': 'Support requested. You will be notified when your private AI agent is ready.',
    'agent_deployed': 'Your agent is ready. Use the paperclip to import files for your knowledge base.',
    'files_archived': 'Update your knowledge base using the [Stored Files] tab.',
    'indexing': 'Knowledge base being indexed. This can take up to 30 minutes.',
    'patient_summary': 'Your patient summary is available. Ask your agent for it in the chat anytime.',
    'link_stored': 'Open [Saved Chats] to restore one or share a deep link.'
  };
  
  return tips[workflowStage || ''] || '';
};

const updateContextualTip = async () => {
  if (!props.user?.userId) {
    contextualTip.value = 'User not logged in';
    return;
  }

  // Priority 1: If indexing is active, show indexing status
  if (indexingStatus.value && indexingStatus.value.active) {
    const status = indexingStatus.value;
    if (status.phase === 'indexing' || status.phase === 'indexing_started') {
      contextualTip.value = 'Knowledge base being indexed. This can take up to 30 minutes.';
    } else if (status.phase === 'complete') {
      contextualTip.value = `KB Indexing Complete: ${status.filesIndexed} files indexed`;
      // Clear after a short delay
      setTimeout(() => {
        indexingStatus.value = null;
        updateContextualTip();
      }, 3000);
    } else if (status.phase === 'error') {
      contextualTip.value = 'KB Indexing Error';
      // Clear after a short delay
      setTimeout(() => {
        indexingStatus.value = null;
        updateContextualTip();
      }, 5000);
    } else {
      contextualTip.value = `KB Setup: ${status.phase}`;
    }
    return;
  }

  try {
    // Priority 2: Fetch user document to get workflowStage
    const userResponse = await fetch(`http://localhost:3001/api/user-status?userId=${encodeURIComponent(props.user.userId)}`, {
      credentials: 'include'
    });

    if (!userResponse.ok) {
      contextualTip.value = 'Unable to load status';
      return;
    }

    const userData = await userResponse.json();
    const workflowStage = userData.workflowStage || null;
    
    // Check if workflowStage is 'indexing' (even if frontend polling isn't active)
    if (workflowStage === 'indexing') {
      contextualTip.value = 'Knowledge base being indexed. This can take up to 30 minutes.';
      return;
    }
    
    // Priority 3: Check UI state (public_llm, chat_modified)
    // These are computed, not saved to database
    if (selectedProvider.value !== 'Private AI') {
      contextualTip.value = 'Public AIs see only what you see in the chat, including any paperclip documents.';
      return;
    }
    
    if (messages.value.length > 0) {
      contextualTip.value = 'You can save the chat to your computer or save it online.';
      return;
    }

    // Priority 4: Get tip for workflow stage
    const tip = getWorkflowTip(workflowStage);
    if (tip) {
      contextualTip.value = tip;
    } else {
      // Fallback to default message if no tip found
      contextualTip.value = 'Ready to chat';
    }
  } catch (error) {
    console.error('Failed to update contextual tip:', error);
    contextualTip.value = 'Error loading status';
  }
};

onMounted(() => {
  loadProviders();
  loadSavedChatCount();
  syncAgent();
  updateContextualTip();
  
  // Update tip periodically and when saved chat count changes
  watch(() => savedChatCount.value, () => {
    updateContextualTip();
  });
  
  // Update tip when messages change (for chat_modified state)
  watch(() => messages.value.length, () => {
    updateContextualTip();
  });
  
  // Update tip when provider changes (for public_llm state)
  watch(() => selectedProvider.value, () => {
    updateContextualTip();
  });
  
  // Update tip every 30 seconds to pick up changes
  setInterval(() => {
    updateContextualTip();
  }, 30000);
});
</script>

<style scoped>
.chat-interface {
  width: 100%;
  height: 100vh;
}

.chat-interface .q-card {
  height: 100%;
}

.chat-messages {
  background-color: #fafafa;
}

.edit-buttons {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.message-preview {
  background: #f8f9fa;
  border: 1px solid #dee2e6;
  border-radius: 4px;
  padding: 10px;
  margin: 10px 0;
}

.message-content {
  margin-top: 5px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

