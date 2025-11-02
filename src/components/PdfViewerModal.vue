<template>
  <q-dialog v-model="isOpen" maximized>
    <q-card>
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">{{ fileName }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section class="q-pt-md">
        <div v-if="pdfUrl" class="pdf-container">
          <VuePDF
            :pdf="pdfDocument"
            :page="currentPage"
            :scale="scale"
            :textLayer="true"
            class="pdf-viewer"
            @loaded="onPdfLoaded"
            @error="onPdfError"
          />
          
          <!-- PDF Controls -->
          <div class="pdf-controls q-mt-md">
            <q-btn 
              icon="chevron_left" 
              @click="previousPage" 
              :disable="currentPage <= 1"
              size="sm"
              color="primary"
            />
            <span class="page-info">{{ currentPage }} / {{ totalPages }}</span>
            <q-btn 
              icon="chevron_right" 
              @click="nextPage" 
              :disable="currentPage >= totalPages"
              size="sm"
              color="primary"
            />
            
            <!-- Page number input -->
            <div class="page-input-container">
              <q-input
                v-model.number="pageInput"
                type="number"
                :min="1"
                :max="totalPages"
                dense
                outlined
                class="page-input"
                @keyup.enter="goToPage"
                @blur="goToPage"
              />
              <q-btn 
                icon="arrow_forward" 
                @click="goToPage" 
                size="sm"
                flat
                class="go-button"
              />
            </div>
            
            <q-btn 
              icon="zoom_out" 
              @click="zoomOut" 
              size="sm"
              color="primary"
            />
            <span class="scale-info">{{ Math.round(scale * 100) }}%</span>
            <q-btn 
              icon="zoom_in" 
              @click="zoomIn" 
              size="sm"
              color="primary"
            />
          </div>
        </div>

        <!-- No PDF state -->
        <div v-else class="no-pdf">
          <q-icon name="description" size="40px" color="grey" />
          <p>No PDF to display</p>
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { VuePDF } from '@tato30/vue-pdf';
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
}

interface Props {
  modelValue: boolean;
  file?: {
    fileUrl?: string;
    bucketKey?: string;
    originalFile?: File;
    name?: string;
  };
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const isOpen = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
});

const fileName = computed(() => props.file?.name || 'PDF Viewer');

// Reactive state
const currentPage = ref(1);
const totalPages = ref(0);
const scale = ref(1.0);
const pageInput = ref('');
const pdfDocument = ref<any>(null);
const isLoading = ref(false);

// Computed
const pdfUrl = computed(() => {
  if (!props.file) return '';
  
  if (props.file.fileUrl) {
    return props.file.fileUrl;
  }
  
  if (props.file.originalFile instanceof File) {
    return URL.createObjectURL(props.file.originalFile);
  }
  
  return '';
});

// Methods
const loadPdfDocument = async () => {
  if (!pdfUrl.value) {
    pdfDocument.value = null;
    totalPages.value = 0;
    isLoading.value = false;
    return;
  }

  if (isLoading.value) {
    return;
  }

  try {
    isLoading.value = true;
    const loadingTask = pdfjsLib.getDocument(pdfUrl.value);
    pdfDocument.value = loadingTask;
    const pdf = await loadingTask.promise;
    totalPages.value = pdf.numPages || 0;
  } catch (error) {
    console.error('PDF loading error:', error);
    pdfDocument.value = null;
    totalPages.value = 0;
  } finally {
    isLoading.value = false;
  }
};

const onPdfLoaded = (pdf: any) => {
  if (totalPages.value === 0 && pdf.numPages && pdf.numPages > 0) {
    totalPages.value = pdf.numPages;
  }
};

const onPdfError = (err: any) => {
  console.error('PDF loading error:', err);
  totalPages.value = 0;
};

const previousPage = () => {
  if (currentPage.value > 1) {
    currentPage.value--;
  }
};

const nextPage = () => {
  if (totalPages.value === 0) {
    return;
  }
  if (currentPage.value < totalPages.value) {
    currentPage.value++;
  }
};

const zoomIn = () => {
  scale.value = Math.min(scale.value + 0.25, 3.0);
};

const zoomOut = () => {
  scale.value = Math.max(scale.value - 0.25, 0.5);
};

const goToPage = () => {
  const targetPage = pageInput.value;
  
  if (targetPage >= 1 && targetPage <= totalPages.value) {
    currentPage.value = targetPage;
    pageInput.value = '';
  } else {
    pageInput.value = '';
  }
};

// Watch for file changes
watch(() => props.file, (newFile) => {
  if (newFile && !isLoading.value) {
    currentPage.value = 1;
    totalPages.value = 0;
    loadPdfDocument();
  }
}, { immediate: true });
</script>

<style scoped>
.pdf-container {
  display: flex;
  flex-direction: column;
  height: 70vh;
  overflow: hidden;
}

.pdf-viewer {
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: auto;
  position: relative;
}

.pdf-viewer :deep(.vue-pdf-embed) {
  width: 100% !important;
  height: auto !important;
  max-width: 100% !important;
  display: block !important;
}

.pdf-viewer :deep(.textLayer) {
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
  opacity: 0.2;
  line-height: 1.0;
  pointer-events: auto;
}

.pdf-viewer :deep(.textLayer > span) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}

.pdf-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px;
  border-top: 1px solid #eee;
  flex-wrap: wrap;
}

.page-info {
  font-weight: 500;
  min-width: 60px;
  text-align: center;
}

.page-input-container {
  display: flex;
  align-items: center;
  gap: 4px;
}

.page-input {
  width: 60px;
}

.scale-info {
  font-weight: 500;
  min-width: 50px;
  text-align: center;
}

.no-pdf {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 400px;
  gap: 16px;
}
</style>

