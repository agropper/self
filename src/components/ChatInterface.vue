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
                :disable="isStreaming"
              />
              <q-btn 
                flat 
                dense 
                size="sm"
                color="secondary" 
                label="SAVE TO GROUP"
                icon="group"
                @click="saveToGroup"
                :disable="isStreaming"
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
              />
            </div>
            <div class="col">
              <q-input
                v-model="inputMessage"
                label="Type your message"
                outlined
                dense
                @keyup.enter="sendMessage"
              />
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
          <div class="row q-gutter-sm q-mt-sm q-pt-sm" style="border-top: 1px solid #eee; align-items: center">
            <div class="col-auto">
              <q-btn flat dense round icon="attach_file" class="text-grey-6" @click="triggerFileInput" />
              <input
                ref="fileInput"
                type="file"
                style="display: none"
                @change="handleFileSelect"
              />
            </div>
            <div class="col text-center text-body2 text-grey-7">
              User: {{ props.user?.userId || 'Guest' }}
              <q-btn flat dense label="SIGN OUT" color="grey-8" @click="handleSignOut" class="q-ml-sm" />
            </div>
            <div class="col-auto"></div>
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watch, nextTick, watchEffect } from 'vue';
import PdfViewerModal from './PdfViewerModal.vue';
import SavedChatsModal from './SavedChatsModal.vue';
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
const selectedProvider = ref<string>('Anthropic');
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
const editingMessageIdx = ref<number[]>([]);
const showDeleteDialog = ref(false);
const messageToDelete = ref<Message | null>(null);
const precedingUserMessage = ref<Message | null>(null);
const chatMessagesRef = ref<HTMLElement | null>(null);

// Provider labels map
const providerLabels: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  digitalocean: 'DigitalOcean'
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
    providers.value = ['anthropic'];
    selectedProvider.value = providerLabels['anthropic'] || 'Anthropic';
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

  messages.value.push(userMessage);
  inputMessage.value = '';
  
  isStreaming.value = true;

  try {
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
  }
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
};

// Auto-scroll chat to bottom when messages change
const scrollToBottom = async () => {
  await nextTick();
  await nextTick(); // Double nextTick to ensure DOM is fully updated
  if (chatMessagesRef.value) {
    chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight;
  }
};

// Watch for specific changes and trigger scroll with flush: 'post'
watch(() => [messages.value.length, messages.value[messages.value.length - 1]?.content], () => {
  scrollToBottom();
}, { flush: 'post' });

onMounted(() => {
  loadProviders();
  loadSavedChatCount();
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

