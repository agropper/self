<template>
  <div class="lists-container q-pa-md">
    <div class="row items-center q-mb-md">
      <div class="col">
        <div class="text-h4">Lists</div>
        <div class="text-caption text-grey">Extract structured lists from your PDF files</div>
      </div>
      <div class="col-auto">
        <q-btn
          flat
          icon="arrow_back"
          label="Back to Chat"
          @click="$emit('back-to-chat')"
        />
      </div>
    </div>

    <!-- File Selection (hidden if saved results exist) -->
    <q-card v-if="!hasSavedResults" class="q-mb-md">
      <q-card-section>
        <div class="text-h6 q-mb-md">Select PDF File</div>
        
        <!-- File Upload -->
        <div class="q-mb-md">
          <q-file
            v-model="selectedFile"
            label="Upload PDF File"
            accept=".pdf"
            outlined
            clearable
          >
            <template v-slot:prepend>
              <q-icon name="attach_file" />
            </template>
          </q-file>
          <q-btn
            v-if="selectedFile"
            color="primary"
            label="Process PDF"
            icon="play_arrow"
            class="q-mt-sm"
            @click="handleFileSelected(selectedFile)"
            :loading="isProcessing"
          />
        </div>

        <!-- Or Select from User Files -->
        <div v-if="userFiles.length > 0" class="q-mt-md">
          <div class="text-subtitle2 q-mb-sm">Or select from your files:</div>
          <div class="row q-col-gutter-sm">
            <div class="col">
              <q-select
                v-model="selectedBucketKey"
                :options="userFiles"
                option-label="fileName"
                option-value="bucketKey"
                label="Select File"
                outlined
                clearable
                emit-value
                map-options
              >
                <template v-slot:option="scope">
                  <q-item v-bind="scope.itemProps">
                    <q-item-section>
                      <q-item-label>{{ scope.opt.fileName }}</q-item-label>
                      <q-item-label caption>{{ scope.opt.bucketKey }}</q-item-label>
                    </q-item-section>
                  </q-item>
                </template>
              </q-select>
            </div>
            <div class="col-auto">
              <q-btn
                v-if="selectedBucketKey"
                color="primary"
                label="Process PDF"
                icon="play_arrow"
                @click="handleBucketFileSelected(selectedBucketKey)"
                :loading="isProcessing"
                :disable="!selectedBucketKey"
              />
            </div>
          </div>
        </div>
      </q-card-section>
    </q-card>

    <!-- Loading State -->
    <div v-if="isProcessing" class="text-center q-pa-lg">
      <q-spinner size="3em" color="primary" />
      <div class="q-mt-md">Processing PDF... This may take a moment.</div>
      <div class="text-caption text-grey q-mt-sm">Extracting text with page boundaries preserved</div>
    </div>

    <!-- Error State -->
    <q-banner v-if="error" rounded class="bg-negative text-white q-mb-md">
      <template v-slot:avatar>
        <q-icon name="error" />
      </template>
      {{ error }}
    </q-banner>

    <!-- Results -->
    <div v-if="pdfData && !isProcessing">
      <!-- PDF Info -->
      <q-card class="q-mb-md">
        <q-card-section>
          <div class="row items-center">
            <div class="col">
              <div class="text-h6">PDF Information</div>
              <div class="q-mt-sm">
                <div><strong>Total Pages:</strong> {{ pdfData.totalPages }}</div>
                <div v-if="selectedFileName"><strong>File:</strong> {{ selectedFileName }}</div>
              </div>
            </div>
            <div class="col-auto">
              <div class="row q-gutter-sm">
                <q-btn
                  v-if="hasSavedResults"
                  color="secondary"
                  icon="refresh"
                  label="Re-process PDF"
                  @click="reprocessPdf"
                  :loading="isProcessing"
                />
                <q-btn
                  color="primary"
                  icon="download"
                  label="Download Markdown"
                  @click="downloadMarkdown"
                />
              </div>
            </div>
          </div>
        </q-card-section>
      </q-card>

      <!-- Markdown Categories List -->
      <q-card v-if="categories.length > 0 || pdfData?.categoryError" class="q-mb-md">
        <q-card-section>
          <div class="text-h6 q-mb-md">Markdown Categories ({{ categories.length }})</div>
          
          <!-- Show category extraction error if present -->
          <q-banner v-if="pdfData?.categoryError" rounded class="bg-negative text-white q-mb-md">
            <template v-slot:avatar>
              <q-icon name="error" />
            </template>
            <div class="text-subtitle2 q-mb-xs">Failed to extract categories:</div>
            {{ pdfData.categoryError }}
          </q-banner>
          
          <q-list v-if="categories.length > 0" bordered separator>
            <q-item 
              v-for="(cat, index) in categories" 
              :key="index"
              :clickable="cat.category.toLowerCase().includes('clinical notes')"
              @click="cat.category.toLowerCase().includes('clinical notes') ? processCategory(cat.category) : null"
              :class="{ 'cursor-pointer': cat.category.toLowerCase().includes('clinical notes') }"
            >
              <q-item-section>
                <q-item-label>
                  {{ cat.category }}
                  <q-icon 
                    v-if="cat.category.toLowerCase().includes('clinical notes')" 
                    name="play_arrow" 
                    size="sm" 
                    class="q-ml-sm text-primary"
                  />
                </q-item-label>
                <!-- Show processing status for Clinical Notes -->
                <q-item-label 
                  v-if="cat.category.toLowerCase().includes('clinical notes')"
                  caption
                  class="q-mt-xs"
                >
                  <div v-if="processingCategory === cat.category" class="text-primary">
                    <q-spinner size="xs" /> Processing...
                  </div>
                  <div v-else-if="categoryProcessingStatus[cat.category]?.indexed > 0" class="text-positive">
                    ✅ Indexed {{ categoryProcessingStatus[cat.category].indexed }} of {{ categoryProcessingStatus[cat.category].total }} notes
                  </div>
                  <div v-else-if="categoryProcessingStatus[cat.category]?.total === 0" class="text-grey">
                    Click to process
                  </div>
                  <div v-else-if="categoryProcessingStatus[cat.category]" class="text-warning">
                    ⚠️ Failed to index notes
                  </div>
                  <div v-else class="text-grey">
                    Click to process
                  </div>
                  <div 
                    v-if="categoryProcessingStatus[cat.category]?.errors && categoryProcessingStatus[cat.category].errors.length > 0"
                    class="text-negative q-mt-xs"
                  >
                    Errors: {{ categoryProcessingStatus[cat.category].errors.join(', ') }}
                  </div>
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-item-label>
                  <q-badge color="primary">{{ cat.count }}</q-badge>
                </q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>

      <!-- Clinical Notes List (only shown when processed) -->
      <q-card v-if="hasCategoryBeenProcessed('clinical notes')" class="q-mb-md">
        <q-card-section>
          <div class="text-h6 q-mb-md">Clinical Notes</div>
          
          <div v-if="isLoadingClinicalNotes" class="text-center q-pa-md">
            <q-spinner size="2em" color="primary" />
            <div class="q-mt-sm text-caption">Loading clinical notes...</div>
          </div>
          
          <div v-else-if="clinicalNotes.length === 0" class="text-center q-pa-md text-grey">
            No clinical notes found. Click "Clinical Notes" in the Markdown Categories list to process.
          </div>
          
          <q-list v-else bordered separator>
            <q-item 
              v-for="note in clinicalNotes" 
              :key="note.id"
              clickable
              @click="copyNoteToClipboard(note)"
              class="cursor-pointer"
            >
              <q-item-section>
                <q-item-label class="text-body2">
                  {{ formatNoteDescription(note) }}
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-item-label caption>
                  <span v-if="note.fileName" class="text-grey">{{ note.fileName }}</span>
                  <span v-if="note.page > 0" class="text-grey q-ml-sm">Page {{ note.page }}</span>
                </q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';

const $q = useQuasar();

interface Props {
  userId: string;
}

const props = defineProps<Props>();

defineEmits<{
  'back-to-chat': [];
}>();

interface UserFile {
  fileName: string;
  bucketKey: string;
  fileType?: string;
}

interface PdfPage {
  page: number;
  text: string;
  markdown: string;
  lineCount: number;
  itemCount: number;
}

interface MarkdownCategory {
  category: string;
  count: number;
}

interface ClinicalNotesIndexed {
  total: number;
  indexed: number;
  errors: string[];
}

interface ClinicalNote {
  id: string;
  type: string;
  author: string;
  category: string;
  created: string;
  date: string;
  fileName: string;
  page: number;
}

interface PdfData {
  totalPages: number;
  pages: PdfPage[];
  categories: MarkdownCategory[];
  fullMarkdown: string;
  categoryError?: string;
}

const selectedFile = ref<File | null>(null);
const selectedBucketKey = ref<string | null>(null);
const selectedFileName = ref<string>('');
const userFiles = ref<UserFile[]>([]);
const isProcessing = ref(false);
const error = ref<string>('');
const pdfData = ref<PdfData | null>(null);
const categories = ref<MarkdownCategory[]>([]);
const activePageTab = ref<number>(1);
const clinicalNotes = ref<ClinicalNote[]>([]);
const isLoadingClinicalNotes = ref(false);
const hasSavedResults = ref(false);
const savedPdfBucketKey = ref<string | null>(null);
const savedResultsBucketKey = ref<string | null>(null);
const processingCategory = ref<string | null>(null);
const categoryProcessingStatus = ref<Record<string, { total: number; indexed: number; errors: string[] }>>({});

const loadUserFiles = async () => {
  try {
    const response = await fetch(`/api/user-files?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    
    if (response.ok) {
      const result = await response.json();
      const pdfFiles = (result.files || [])
        .filter((f: any) => {
          const fileName = f.fileName?.toLowerCase() || '';
          const fileType = f.fileType?.toLowerCase();
          return fileType === 'pdf' || fileName.endsWith('.pdf');
        })
        .map((f: any) => ({
          fileName: f.fileName,
          bucketKey: f.bucketKey,
          fileType: f.fileType
        }));
      
      userFiles.value = pdfFiles;
    }
  } catch (err) {
    console.error('Error loading user files:', err);
  }
};

const loadSavedResults = async () => {
  try {
    const response = await fetch('/api/files/lists/results', {
      credentials: 'include'
    });
    
    if (response.ok) {
      const result = await response.json();
      if (result.hasResults && result.results) {
        hasSavedResults.value = true;
        savedPdfBucketKey.value = result.pdfBucketKey;
        
        // Load the saved processing results
        pdfData.value = {
          totalPages: result.results.totalPages,
          pages: result.results.pages,
          categories: result.results.categories || [],
          fullMarkdown: result.results.fullMarkdown,
          categoryError: result.results.categoryError
        };
        categories.value = result.results.categories || [];
        selectedFileName.value = result.results.fileName || '';
        savedResultsBucketKey.value = result.resultsBucketKey;
        
        if (result.results.pages && result.results.pages.length > 0) {
          activePageTab.value = result.results.pages[0].page;
        }
      }
    }
  } catch (err) {
    console.error('Error loading saved results:', err);
  }
};

const reprocessPdf = async () => {
  if (!savedPdfBucketKey.value) {
    error.value = 'No saved PDF found to re-process';
    return;
  }
  
  await handleBucketFileSelected(savedPdfBucketKey.value);
};

// Helper function to check if a category has been processed (case-insensitive)
const hasCategoryBeenProcessed = (categoryName: string): boolean => {
  const normalized = categoryName.toLowerCase();
  return Object.keys(categoryProcessingStatus.value).some(
    key => key.toLowerCase() === normalized && categoryProcessingStatus.value[key]?.indexed > 0
  );
};

const handleFileSelected = async (file: File | null) => {
  if (!file) {
    console.warn('No file selected');
    return;
  }
  
  console.log('Processing uploaded file:', file.name);
  selectedFileName.value = file.name;
  selectedBucketKey.value = null;
  await processPdfFile(file);
};

const handleBucketFileSelected = async (bucketKey: string | null) => {
  if (!bucketKey) {
    console.warn('No bucket key selected');
    return;
  }
  
  const file = userFiles.value.find(f => f.bucketKey === bucketKey);
  if (file) {
    console.log('Processing bucket file:', file.fileName, bucketKey);
    selectedFileName.value = file.fileName;
    selectedFile.value = null;
    await processPdfFromBucket(bucketKey);
  } else {
    console.error('File not found for bucket key:', bucketKey);
    error.value = 'Selected file not found';
  }
};

const processPdfFile = async (file: File) => {
  isProcessing.value = true;
  error.value = '';
  pdfData.value = null;
  categories.value = [];

  try {
    console.log('Starting PDF processing for file:', file.name, 'Size:', file.size);
    const formData = new FormData();
    formData.append('pdfFile', file);

    console.log('Sending request to /api/files/pdf-to-markdown');
    const response = await fetch('/api/files/pdf-to-markdown?extractCategories=true', {
      method: 'POST',
      body: formData,
      credentials: 'include'
    });

    console.log('Response status:', response.status, response.statusText);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}: ${response.statusText}` }));
      throw new Error(errorData.error || 'Failed to process PDF');
    }

    const data = await response.json();
    console.log('PDF processing successful:', {
      totalPages: data.totalPages,
      pagesCount: data.pages?.length,
      categoriesCount: data.categories?.length
    });
    
    pdfData.value = data;
    categories.value = data.categories || [];
    hasSavedResults.value = true; // Mark that we now have saved results
    if (data.savedPdfBucketKey) {
      savedPdfBucketKey.value = data.savedPdfBucketKey;
    }
    if (data.savedResultsBucketKey) {
      savedResultsBucketKey.value = data.savedResultsBucketKey;
    }
    
    if (data.pages && data.pages.length > 0) {
      activePageTab.value = data.pages[0].page;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to process PDF';
    error.value = errorMessage;
    console.error('PDF processing error:', err);
  } finally {
    isProcessing.value = false;
  }
};

const processPdfFromBucket = async (bucketKey: string) => {
  isProcessing.value = true;
  error.value = '';
  pdfData.value = null;
  categories.value = [];

  try {
    console.log('Starting PDF processing for bucket file:', bucketKey);
    const url = `/api/files/pdf-to-markdown/${encodeURIComponent(bucketKey)}?extractCategories=true`;
    console.log('Sending request to:', url);
    
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include'
    });

    console.log('Response status:', response.status, response.statusText);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}: ${response.statusText}` }));
      throw new Error(errorData.error || 'Failed to process PDF');
    }

    const data = await response.json();
    console.log('PDF processing successful:', {
      totalPages: data.totalPages,
      pagesCount: data.pages?.length,
      categoriesCount: data.categories?.length
    });
    
    pdfData.value = data;
    categories.value = data.categories || [];
    hasSavedResults.value = true; // Mark that we now have saved results
    if (data.savedPdfBucketKey) {
      savedPdfBucketKey.value = data.savedPdfBucketKey;
    }
    if (data.savedResultsBucketKey) {
      savedResultsBucketKey.value = data.savedResultsBucketKey;
    }
    
    if (data.pages && data.pages.length > 0) {
      activePageTab.value = data.pages[0].page;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to process PDF';
    error.value = errorMessage;
    console.error('PDF processing error:', err);
  } finally {
    isProcessing.value = false;
  }
};

const processCategory = async (categoryName: string) => {
  if (!savedResultsBucketKey.value) {
    error.value = 'No saved processing results found';
    return;
  }

  processingCategory.value = categoryName;
  
  try {
    const response = await fetch('/api/files/lists/process-category', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        categoryName,
        resultsBucketKey: savedResultsBucketKey.value
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}: ${response.statusText}` }));
      throw new Error(errorData.error || 'Failed to process category');
    }

    const result = await response.json();
    
    // Update processing status
    categoryProcessingStatus.value[categoryName] = {
      total: result.indexed.total,
      indexed: result.indexed.indexed,
      errors: result.indexed.errors || []
    };

    // If it's Clinical Notes, reload the clinical notes list
    if (categoryName.toLowerCase().includes('clinical notes')) {
      loadClinicalNotes();
    }

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: result.fromCache ? 'info' : 'positive',
        message: result.fromCache 
          ? `Loaded cached ${categoryName} list`
          : `Processed ${categoryName}: ${result.indexed.indexed} items indexed`,
        timeout: 3000
      });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to process category';
    error.value = errorMessage;
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: errorMessage,
        timeout: 5000
      });
    }
  } finally {
    processingCategory.value = null;
  }
};

const downloadMarkdown = () => {
  if (!pdfData.value || !pdfData.value.fullMarkdown) {
    error.value = 'No markdown content available to download';
    return;
  }

  try {
    // Create a blob with the markdown content
    const blob = new Blob([pdfData.value.fullMarkdown], { type: 'text/markdown' });
    
    // Create a download link
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    
    // Generate filename from original file name or use default
    const baseName = selectedFileName.value 
      ? selectedFileName.value.replace(/\.pdf$/i, '')
      : 'extracted-pdf';
    link.download = `${baseName}.md`;
    
    // Trigger download
    document.body.appendChild(link);
    link.click();
    
    // Cleanup
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    console.log('Markdown file downloaded:', link.download);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to download markdown file';
    console.error('Download error:', err);
  }
};

const loadClinicalNotes = async () => {
  isLoadingClinicalNotes.value = true;
  try {
    const response = await fetch('/api/files/clinical-notes', {
      credentials: 'include'
    });
    
    if (response.ok) {
      const result = await response.json();
      clinicalNotes.value = result.notes || [];
    } else {
      console.error('Failed to load clinical notes:', response.statusText);
    }
  } catch (err) {
    console.error('Error loading clinical notes:', err);
  } finally {
    isLoadingClinicalNotes.value = false;
  }
};

const formatNoteDescription = (note: ClinicalNote): string => {
  const parts: string[] = [];
  
  if (note.type) {
    parts.push(`Type: ${note.type}`);
  }
  if (note.author) {
    parts.push(`Author: ${note.author}`);
  }
  if (note.category) {
    parts.push(`Category: ${note.category}`);
  }
  if (note.created) {
    parts.push(`Created: ${note.created}`);
  }
  
  return parts.join('; ') || 'No details available';
};

const copyNoteToClipboard = async (note: ClinicalNote) => {
  const description = formatNoteDescription(note);
  // Exclude the source document from the search - we want RAG to find it in other documents
  const excludeFile = note.fileName ? ` (excluding ${note.fileName})` : '';
  const query = `Find the encounter note for: ${description} in your knowledge base${excludeFile} and return the filename and page number in that file.`;
  
  try {
    await navigator.clipboard.writeText(query);
    $q.notify({
      message: 'Copied to clipboard!',
      type: 'positive',
      position: 'top',
      timeout: 2000
    });
  } catch (err) {
    console.error('Failed to copy to clipboard:', err);
    // Fallback: try using a temporary textarea
    const textarea = document.createElement('textarea');
    textarea.value = query;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      $q.notify({
        message: 'Copied to clipboard!',
        type: 'positive',
        position: 'top',
        timeout: 2000
      });
    } catch (fallbackErr) {
      console.error('Fallback copy failed:', fallbackErr);
      $q.notify({
        message: 'Failed to copy to clipboard',
        type: 'negative',
        position: 'top',
        timeout: 2000
      });
    }
    document.body.removeChild(textarea);
  }
};

onMounted(() => {
  loadUserFiles();
  loadClinicalNotes();
  loadSavedResults(); // Check for saved results first
});
</script>

<style scoped>
.lists-container {
  max-width: 1400px;
  margin: 0 auto;
}

.markdown-preview {
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 500px;
  overflow-y: auto;
  font-family: 'Courier New', monospace;
  font-size: 0.9em;
}

.text-preview {
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 300px;
  overflow-y: auto;
  font-family: 'Courier New', monospace;
  font-size: 0.9em;
}
</style>

