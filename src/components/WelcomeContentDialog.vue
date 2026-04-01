<template>
  <q-dialog v-model="isOpen" maximized>
    <q-card>
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">{{ title }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section style="max-height: calc(100vh - 50px); overflow-y: auto;">
        <div v-if="loading" class="text-center q-pa-lg">
          <q-spinner size="2em" />
          <div class="q-mt-sm">Loading...</div>
        </div>
        <div v-else-if="sectionContent" class="welcome-section-content">
          <vue-markdown :source="sectionContent" />
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import VueMarkdown from 'vue-markdown-render';

interface Props {
  modelValue: boolean;
  section: 'privacy' | 'faq' | 'about';
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const isOpen = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
});

const titles: Record<string, string> = {
  privacy: 'Privacy',
  faq: 'FAQ',
  about: 'About'
};

const title = computed(() => titles[props.section] || '');

const sectionContent = ref<string>('');
const loading = ref(false);

let cachedMarkdown: string | null = null;

const extractSection = (markdown: string, sectionName: string): string => {
  const marker = `<!-- SECTION:${sectionName} -->`;
  const start = markdown.indexOf(marker);
  if (start === -1) return '';

  const contentStart = start + marker.length;

  // Find the next section marker or end of file
  const nextMarker = markdown.indexOf('<!-- SECTION:', contentStart);
  const content = nextMarker === -1
    ? markdown.slice(contentStart)
    : markdown.slice(contentStart, nextMarker);

  return content.trim();
};

const loadSection = async () => {
  if (!props.modelValue) return;

  loading.value = true;
  try {
    if (!cachedMarkdown) {
      const response = await fetch('/welcome.md', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Failed to load: ${response.status}`);
      cachedMarkdown = await response.text();
    }
    sectionContent.value = extractSection(cachedMarkdown, props.section);
  } catch (err) {
    console.error('Error loading welcome content:', err);
    sectionContent.value = 'Unable to load content.';
  } finally {
    loading.value = false;
  }
};

watch(() => props.modelValue, (newVal) => {
  if (newVal) loadSection();
});
</script>

<style scoped>
.welcome-section-content {
  line-height: 1.6;
}

.welcome-section-content :deep(h2) {
  font-size: 1.4rem;
  margin-top: 1.2rem;
  margin-bottom: 0.8rem;
  font-weight: bold;
}

.welcome-section-content :deep(p) {
  margin-bottom: 1rem;
}

.welcome-section-content :deep(strong) {
  font-weight: bold;
}

.welcome-section-content :deep(a) {
  color: #1976d2;
  text-decoration: none;
}

.welcome-section-content :deep(a:hover) {
  text-decoration: underline;
}

.welcome-section-content :deep(ul), .welcome-section-content :deep(ol) {
  margin-left: 1.5rem;
  margin-bottom: 1rem;
}

.welcome-section-content :deep(li) {
  margin-bottom: 0.5rem;
}
</style>
