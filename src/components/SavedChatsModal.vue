<template>
  <q-dialog v-model="isOpen" persistent>
    <q-card style="min-width: 600px; max-width: 800px;">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">Saved Chats</div>
        <q-space />
        <q-btn icon="close" flat round dense @click="closeModal" />
      </q-card-section>

      <q-card-section>
        <div v-if="loading" class="text-center q-pa-md">
          <q-spinner size="2em" />
          <div class="q-mt-sm">Loading saved chats...</div>
        </div>

        <div v-else-if="error" class="text-center q-pa-md">
          <q-icon name="error" color="negative" size="40px" />
          <div class="text-negative q-mt-sm">{{ error }}</div>
          <q-btn
            label="Retry"
            color="primary"
            @click="loadSavedChats"
            class="q-mt-md"
          />
        </div>

        <div v-else-if="savedChats.length === 0" class="text-center q-pa-md text-grey">
          <q-icon name="chat" size="3em" />
          <div class="q-mt-sm">No saved chats found</div>
          <div class="text-caption">Create your first chat by posting a message and saving it!</div>
        </div>

        <div v-else class="chat-list">
          <div 
            v-for="chat in sortedChats" 
            :key="chat._id" 
            class="chat-item q-pa-md q-mb-sm"
          >
            <div class="row items-center justify-between">
              <div class="col clickable" @click="openChat(chat)">
                <div class="text-weight-medium text-body1 q-mb-xs">
                  {{ formatDate(chat.updatedAt || chat.createdAt) }}
                </div>
                
                <!-- First message preview (up to 100 characters) -->
                <div v-if="getFirstMessagePreview(chat)" class="text-caption text-grey q-mb-xs">
                  {{ getFirstMessagePreview(chat) }}...
                </div>
                
                <!-- File attachments -->
                <div v-if="chat.uploadedFiles && chat.uploadedFiles.length > 0" class="text-caption text-grey q-mt-xs">
                  <q-icon name="attach_file" size="xs" />
                  <span>{{ formatFileList(chat.uploadedFiles) }}</span>
                </div>
              </div>
              
              <div class="row items-center">
                <q-btn
                  flat
                  round
                  dense
                  icon="delete"
                  color="negative"
                  @click.stop="handleDeleteChat(chat._id)"
                  title="Delete chat"
                />
              </div>
            </div>
          </div>
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';

interface SavedChat {
  _id: string;
  type: string;
  shareId: string;
  currentUser: string;
  connectedKB: string;
  chatHistory: any[];
  uploadedFiles: any[];
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface Props {
  modelValue: boolean;
  currentUser: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'chat-selected': [chat: SavedChat];
}>();

const isOpen = ref(props.modelValue);
const savedChats = ref<SavedChat[]>([]);
const loading = ref(false);
const error = ref('');

const loadSavedChats = async () => {
  loading.value = true;
  error.value = '';

  try {
    const response = await fetch(`/api/user-chats?userId=${encodeURIComponent(props.currentUser)}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch chats: ${response.statusText}`);
    }
    const result = await response.json();
    savedChats.value = result.chats || [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load chats';
  } finally {
    loading.value = false;
  }
};

const openChat = async (chat: SavedChat) => {
  try {
    const response = await fetch(`/api/load-chat/${chat._id}`);
    if (!response.ok) {
      throw new Error(`Failed to load chat: ${response.statusText}`);
    }
    const result = await response.json();
    emit('chat-selected', result.chat);
    closeModal();
  } catch (err) {
    console.error('Failed to load full chat data:', err);
    emit('chat-selected', chat);
    closeModal();
  }
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatFileList = (files: any[]) => {
  if (!files || files.length === 0) return '';
  
  const maxFiles = 3;
  if (files.length <= maxFiles) {
    return files.map(file => file.name || 'Unknown file').join(', ');
  } else {
    const shownFiles = files.slice(0, maxFiles).map(file => file.name || 'Unknown file');
    const remainingCount = files.length - maxFiles;
    return `${shownFiles.join(', ')} and ${remainingCount} more`;
  }
};

const getFirstMessagePreview = (chat: SavedChat): string => {
  if (chat.chatHistory && chat.chatHistory.length > 1) {
    const secondMessage = chat.chatHistory[1];
    if (secondMessage.content && typeof secondMessage.content === 'string') {
      return secondMessage.content.substring(0, 100);
    }
  }
  return '';
};

const handleDeleteChat = async (chatId: string) => {
  try {
    const response = await fetch(`/api/delete-chat/${chatId}`, {
      method: 'DELETE',
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    savedChats.value = savedChats.value.filter(chat => chat._id !== chatId);
  } catch (err) {
    console.error("Failed to delete chat:", err);
    error.value = err instanceof Error ? err.message : 'Failed to delete chat';
  }
};

const sortedChats = computed(() => {
  return [...savedChats.value].sort((a, b) => {
    const dateA = new Date(a.updatedAt || a.createdAt);
    const dateB = new Date(b.updatedAt || b.createdAt);
    return dateB.getTime() - dateA.getTime();
  });
});

const closeModal = () => {
  isOpen.value = false;
};

watch(() => props.modelValue, (newValue) => {
  isOpen.value = newValue;
  if (newValue) {
    loadSavedChats();
  }
});

watch(isOpen, (newValue) => {
  emit('update:modelValue', newValue);
});

onMounted(() => {
  if (isOpen.value) {
    loadSavedChats();
  }
});
</script>

<style scoped lang="scss">
.chat-list {
  .chat-item {
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    transition: all 0.2s ease;
    cursor: pointer;
    
    &:hover {
      border-color: #1976d2;
      box-shadow: 0 2px 8px rgba(25, 118, 210, 0.15);
    }
    
    .clickable {
      cursor: pointer;
    }
  }
}
</style>

