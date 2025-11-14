<template>
  <q-dialog v-model="isOpen" maximized>
    <q-card>
      <q-card-section class="row items-center q-pb-none">
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section style="max-height: calc(100vh - 50px); overflow-y: auto;">
        <div v-if="loading" class="text-center q-pa-lg">
          <q-spinner size="2em" />
          <div class="q-mt-sm">Loading privacy policy...</div>
        </div>
        <div v-else-if="error" class="text-negative q-pa-md">
          Error loading privacy policy: {{ error }}
        </div>
        <div v-else-if="privacyContent" class="privacy-content">
          <vue-markdown :source="privacyContent" />
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue';
import VueMarkdown from 'vue-markdown-render';

interface Props {
  modelValue: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const isOpen = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
});

const privacyContent = ref<string>('');
const loading = ref(false);
const error = ref<string | null>(null);

const loadPrivacyContent = async () => {
  if (!props.modelValue) return;
  
  loading.value = true;
  error.value = null;
  
  try {
    const response = await fetch('/Privacy.md');
    if (!response.ok) {
      throw new Error(`Failed to load: ${response.statusText}`);
    }
    let text = await response.text();
    // Remove the first H1 line (redundant with dialog title)
    // Match "# Title" at the start of the file
    text = text.replace(/^#\s+[^\n]+\n\n?/, '');
    privacyContent.value = text;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error loading privacy policy:', err);
  } finally {
    loading.value = false;
  }
};

watch(() => props.modelValue, (newVal) => {
  if (newVal) {
    loadPrivacyContent();
  }
});

// Also load on mount if dialog is already open
onMounted(() => {
  if (props.modelValue) {
    loadPrivacyContent();
  }
});
</script>

<style scoped>
.privacy-content {
  line-height: 1.6;
}

.privacy-content :deep(h1) {
  font-size: 1.8rem;
  margin-top: 1.5rem;
  margin-bottom: 1rem;
  font-weight: bold;
}

.privacy-content :deep(h2) {
  font-size: 1.4rem;
  margin-top: 1.2rem;
  margin-bottom: 0.8rem;
  font-weight: bold;
}

.privacy-content :deep(h3) {
  font-size: 1.2rem;
  margin-top: 1rem;
  margin-bottom: 0.6rem;
  font-weight: bold;
}

.privacy-content :deep(p) {
  margin-bottom: 1rem;
}

.privacy-content :deep(hr) {
  margin: 1.5rem 0;
  border: none;
  border-top: 1px solid #ddd;
}

.privacy-content :deep(strong) {
  font-weight: bold;
}

.privacy-content :deep(a) {
  color: #1976d2;
  text-decoration: none;
}

.privacy-content :deep(a:hover) {
  text-decoration: underline;
}

.privacy-content :deep(ul), .privacy-content :deep(ol) {
  margin-left: 1.5rem;
  margin-bottom: 1rem;
}

.privacy-content :deep(li) {
  margin-bottom: 0.5rem;
}
</style>

