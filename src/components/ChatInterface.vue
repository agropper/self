<template>
  <div class="chat-interface">
    <q-card class="full-height">
      <q-card-section class="q-pa-none full-height flex column">
        <!-- File Info Bar -->
        <div v-if="selectedFile" class="q-px-md q-pt-md q-pb-sm" style="flex-shrink: 0; border-bottom: 1px solid #eee;">
          <div class="row items-center q-gutter-xs">
            <span class="text-xs text-grey-7">📎 {{ selectedFile.name }}</span>
            <q-btn 
              v-if="selectedFile.type === 'pdf'"
              flat dense round size="xs" 
              icon="visibility" 
              @click="viewFile(selectedFile)"
            />
            <q-btn flat dense round size="xs" icon="close" @click="selectedFile = null" />
          </div>
        </div>
        
        <div v-if="isUploadingFile" class="q-px-md q-pt-sm q-pb-sm" style="flex-shrink: 0; border-bottom: 1px solid #eee;">
          <div class="text-xs text-grey-6">Uploading...</div>
        </div>

        <!-- Chat Area -->
        <div class="chat-messages q-pa-md" style="flex: 1; overflow-y: auto; min-height: 0;">
          <div 
            v-for="(msg, idx) in messages" 
            :key="idx"
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
              {{ msg.content }}
            </div>
          </div>
          
          <div v-if="isStreaming" class="text-grey-6">
            Thinking... <q-spinner-dots size="sm" />
          </div>
        </div>

        <!-- Input Area with Provider Selector -->
        <div class="q-pa-md" style="flex-shrink: 0; border-top: 1px solid #eee;">
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import PdfViewerModal from './PdfViewerModal.vue';

interface Message {
  role: 'user' | 'assistant';
  content: string;
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
const selectedFile = ref<UploadedFile | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const isUploadingFile = ref(false);
const showPdfViewer = ref(false);
const viewingFile = ref<UploadedFile | null>(null);

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

// Send message (streaming)
const sendMessage = async () => {
  if (!inputMessage.value || isStreaming.value) return;

  // Build message content with file context if PDF is attached
  let messageContent = inputMessage.value;
  if (selectedFile.value && selectedFile.value.type === 'pdf') {
    messageContent += `\n\n[PDF: ${selectedFile.value.name}]\n${selectedFile.value.content}`;
  }

  const userMessage: Message = {
    role: 'user',
    content: messageContent
  };

  messages.value.push(userMessage);
  inputMessage.value = '';
  
  // Clear selected file after sending
  if (selectedFile.value) {
    selectedFile.value = null;
  }
  
  isStreaming.value = true;

  try {
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
          messages: messages.value,
          options: {
            stream: true
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    // Create assistant message
    const assistantMessage: Message = {
      role: 'assistant',
      content: ''
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
              return;
            }
          } catch (e) {
            // Skip malformed JSON
          }
        }
      }
    }

    isStreaming.value = false;
  } catch (error) {
    console.error('Chat error:', error);
    messages.value.push({
      role: 'assistant',
      content: `Error: ${error instanceof Error ? error.message : 'Failed to get response'}`
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
    selectedFile.value = null;
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
    fileUrl: uploadResult.fileInfo.fileUrl,
    uploadedAt: new Date()
  };

  selectedFile.value = uploadedFile;
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

  selectedFile.value = uploadedFile;
  
  // Add content to input message
  inputMessage.value = `${inputMessage.value}\n\n[File: ${file.name}]\n${text}`.trim();
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

onMounted(() => {
  loadProviders();
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
</style>

