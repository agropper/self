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

    <!-- Update Lists from Initial File -->
    <q-card v-if="!hasSavedResults" class="q-mb-md">
      <q-card-section>
        <div class="text-h6 q-mb-md">Extract Lists from Initial File</div>
        <div class="text-body2 text-grey q-mb-md">
          Process your initial health record file to extract structured lists (Clinical Notes, Medications, etc.)
        </div>
        <q-btn
          color="primary"
          label="Create Lists from Initial File"
          icon="create"
          @click="processInitialFile"
          :loading="isProcessing"
          :disable="!hasInitialFile"
        />
        <div v-if="!hasInitialFile" class="text-caption text-grey q-mt-sm">
          No initial file found. Please upload a file during registration.
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
    <div v-if="(pdfData || markdownContent) && !isProcessing">
      <!-- PDF Info -->
      <q-card v-if="pdfData" class="q-mb-md">
        <q-card-section>
          <div class="row items-center">
            <div class="col">
              <div class="text-h6">Markdown File</div>
              <div class="q-mt-sm">
                <div v-if="pdfData.totalPages"><strong>Total Pages:</strong> {{ pdfData.totalPages }}</div>
                <div v-if="selectedFileName"><strong>File:</strong> {{ selectedFileName }}</div>
                <div v-if="markdownBucketKey" class="text-caption text-grey q-mt-xs">
                  <q-icon name="folder" size="xs" /> Location: <code>{{ markdownBucketKey }}</code>
                </div>
              </div>
            </div>
            <div class="col-auto">
              <div class="row q-gutter-sm">
                <q-btn
                  color="secondary"
                  icon="cleaning_services"
                  label="Clean Up Markdown"
                  @click="cleanupMarkdown"
                  :loading="isCleaningMarkdown"
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

      <!-- Markdown Display -->
      <q-card v-if="markdownContent" class="q-mb-md">
        <q-card-section>
          <div class="text-h6 q-mb-md">Markdown Content</div>
          <div v-if="markdownBucketKey" class="text-caption text-grey q-mb-sm">
            <q-icon name="folder" size="xs" /> Saved to: <code>{{ markdownBucketKey }}</code>
          </div>
          <div class="markdown-preview q-pa-md" style="background: #f5f5f5; border-radius: 4px; max-height: 600px; overflow-y: auto;">
            <pre style="white-space: pre-wrap; font-family: monospace; font-size: 12px; margin: 0;">{{ markdownContent }}</pre>
          </div>
        </q-card-section>
      </q-card>

      <!-- Categories Section -->
      <q-card v-if="categoriesList.length > 0" class="q-mb-md">
        <q-card-section>
          <div class="text-h6 q-mb-md">Categories</div>
          <q-list bordered separator>
            <q-item 
              v-for="(category, index) in categoriesList" 
              :key="index"
              clickable
            >
              <q-item-section>
                <q-item-label>{{ category.name }}</q-item-label>
                <q-item-label caption>
                  starts on 
                  <a 
                    href="#" 
                    @click.prevent="handleCategoryPageClick(category.page)"
                    class="text-primary"
                    style="text-decoration: underline; cursor: pointer;"
                  >
                    page {{ category.page }}
                  </a>
                </q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
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
              clickable
              @click="processCategory(cat.category)"
              class="cursor-pointer"
            >
              <q-item-section>
                <q-item-label>
                  {{ cat.category }}
                  <q-icon 
                    name="play_arrow" 
                    size="sm" 
                    class="q-ml-sm text-primary"
                  />
                </q-item-label>
                <!-- Show processing status for all categories -->
                <q-item-label 
                  caption
                  class="q-mt-xs"
                >
                  <div v-if="processingCategory === cat.category" class="text-primary">
                    <q-spinner size="xs" /> Processing...
                  </div>
                  <div v-else-if="categoryProcessingStatus[cat.category]?.indexed > 0" class="text-positive">
                    ✅ Indexed {{ categoryProcessingStatus[cat.category].indexed }} of {{ categoryProcessingStatus[cat.category].total }} items
                  </div>
                  <div v-else-if="categoryProcessingStatus[cat.category]?.total === 0" class="text-grey">
                    Click to process
                  </div>
                  <div v-else-if="categoryProcessingStatus[cat.category]" class="text-warning">
                    ⚠️ Failed to process
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

      <!-- Category Items List (dynamic - shows currently selected category) -->
      <q-card v-if="currentCategoryDisplay" class="q-mb-md">
        <q-card-section>
          <div class="text-h6 q-mb-md">{{ currentCategoryDisplay }}</div>
          
          <div v-if="isLoadingCategoryItems" class="text-center q-pa-md">
            <q-spinner size="2em" color="primary" />
            <div class="q-mt-sm text-caption">Loading {{ currentCategoryDisplay.toLowerCase() }}...</div>
          </div>
          
          <div v-else-if="categoryItems.length === 0" class="text-center q-pa-md text-grey">
            No items found. Click "{{ currentCategoryDisplay }}" in the Markdown Categories list to process.
          </div>
          
          <q-list v-else bordered separator>
            <q-item 
              v-for="(item, index) in categoryItems" 
              :key="`${currentCategoryDisplay}-${item.id || item.name || index}-${index}`"
              clickable
              @click="copyItemToClipboard(item, currentCategoryDisplay)"
              class="cursor-pointer"
            >
              <q-item-section>
                <q-item-label 
                  class="text-body2"
                  v-if="currentCategoryDisplay && currentCategoryDisplay.toLowerCase().includes('medication')"
                  v-html="formatItemDescription(item, currentCategoryDisplay)"
                />
                <q-item-label 
                  v-else
                  class="text-body2"
                >
                  {{ formatItemDescription(item, currentCategoryDisplay) }}
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-item-label caption>
                  <span v-if="item.fileName" class="text-grey">{{ item.fileName }}</span>
                  <span v-if="item.page > 0" class="text-grey q-ml-sm">Page {{ item.page }}</span>
                </q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>
    </div>
  </div>

  <!-- PDF Viewer Modal -->
  <PdfViewerModal
    v-model="showPdfViewer"
    :file="viewingPdfFile"
    :initial-page="pdfInitialPage"
  />
</template>

<script setup lang="ts">
import PdfViewerModal from './PdfViewerModal.vue';
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

const selectedFileName = ref<string>('');
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
const currentCategoryDisplay = ref<string | null>(null);
const categoryItems = ref<any[]>([]);
const isLoadingCategoryItems = ref(false);
const hasInitialFile = ref(false);
const markdownContent = ref<string>('');
const markdownBucketKey = ref<string | null>(null);
const isCleaningMarkdown = ref(false);
const initialFileInfo = ref<{ bucketKey: string; fileName: string } | null>(null);
const categoriesList = ref<Array<{ name: string; page: number }>>([]);
const showPdfViewer = ref(false);
const viewingPdfFile = ref<{ bucketKey?: string; name?: string } | null>(null);
const pdfInitialPage = ref<number | undefined>(undefined);

const checkInitialFile = async () => {
  try {
    const response = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    
    if (response.ok) {
      const result = await response.json();
      hasInitialFile.value = !!(result.initialFile && result.initialFile.bucketKey);
      if (result.initialFile && result.initialFile.bucketKey) {
        initialFileInfo.value = {
          bucketKey: result.initialFile.bucketKey,
          fileName: result.initialFile.fileName || 'Initial File'
        };
      }
    }
  } catch (err) {
    console.error('Error checking initial file:', err);
  }
};

const loadSavedResults = async () => {
  try {
    // Check if Lists folder exists and has files
    const markdownResponse = await fetch('/api/files/lists/markdown', {
      credentials: 'include'
    });
    
    if (markdownResponse.ok) {
      const markdownResult = await markdownResponse.json();
      
      // If Lists folder doesn't exist or is empty, reset state
      if (!markdownResult.hasMarkdown) {
        console.log('[LISTS] No markdown file found - resetting state');
        hasSavedResults.value = false;
        pdfData.value = null;
        markdownContent.value = '';
        markdownBucketKey.value = null;
        savedPdfBucketKey.value = null;
        savedResultsBucketKey.value = null;
        selectedFileName.value = '';
        categories.value = [];
        categoryProcessingStatus.value = {};
        currentCategoryDisplay.value = null;
        categoryItems.value = [];
        
        // Clean up user document references to old lists
        try {
          await fetch('/api/files/lists/cleanup-user-doc', {
            method: 'POST',
            credentials: 'include'
          });
        } catch (cleanupErr) {
          console.warn('Failed to cleanup user document:', cleanupErr);
        }
        return;
      }
      
      // Markdown file exists - load it
      if (markdownResult.markdown) {
        markdownContent.value = markdownResult.markdown;
        markdownBucketKey.value = markdownResult.markdownBucketKey || null;
        hasSavedResults.value = true;
        
        // Load initial file info if not already loaded
        if (!initialFileInfo.value) {
          await checkInitialFile();
        }
        
        // Extract categories from markdown
        extractCategoriesFromMarkdown(markdownResult.markdown);
        
        // Also try to load results.json if it exists
        const resultsResponse = await fetch('/api/files/lists/results', {
          credentials: 'include'
        });
        
        if (resultsResponse.ok) {
          const resultsResult = await resultsResponse.json();
          if (resultsResult.hasResults && resultsResult.results) {
            pdfData.value = {
              totalPages: resultsResult.results.totalPages,
              pages: resultsResult.results.pages,
              categories: resultsResult.results.categories || [],
              fullMarkdown: resultsResult.results.fullMarkdown,
              categoryError: resultsResult.results.categoryError
            };
            categories.value = resultsResult.results.categories || [];
            selectedFileName.value = resultsResult.results.fileName || '';
            savedResultsBucketKey.value = resultsResult.resultsBucketKey;
            
            if (resultsResult.results.pages && resultsResult.results.pages.length > 0) {
              activePageTab.value = resultsResult.results.pages[0].page;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Error loading saved results:', err);
    // On error, reset state to allow fresh start
    hasSavedResults.value = false;
    pdfData.value = null;
    markdownContent.value = '';
  }
};

// reprocessPdf removed - no longer needed with initial file approach

const formatItemDescription = (item: any, categoryName: string): string => {
  if (categoryName.toLowerCase().includes('clinical notes')) {
    const parts: string[] = [];
    
    // Date first (from created field)
    if (item.created) {
      parts.push(item.created);
    }
    
    // Then Author
    if (item.author) {
      parts.push(item.author);
    }
    
    // Then Category (only if it's not "Clinical Note")
    if (item.category && item.category !== 'Clinical Note') {
      parts.push(item.category);
    }
    
    return parts.join(' ') || 'No details available';
  } else if (categoryName.toLowerCase().includes('medication')) {
    const parts: string[] = [];
    
    // Extract date without location (remove everything after semicolon or common location patterns)
    if (item.date) {
      let dateOnly = item.date.split(';')[0].trim();
      // Remove common location patterns if they appear after the date
      dateOnly = dateOnly.replace(/\s+Mass\s+General\s+Brigham.*$/i, '');
      dateOnly = dateOnly.replace(/\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+.*$/i, ''); // Remove patterns like "Location Name" (2+ capitalized words)
      parts.push(dateOnly);
    }
    
    // Add name and dosage in bold (HTML format)
    if (item.name || item.dosage) {
      const boldParts: string[] = [];
      if (item.name) boldParts.push(`<strong>${item.name}</strong>`);
      if (item.dosage) boldParts.push(`<strong>${item.dosage}</strong>`);
      if (boldParts.length > 0) {
        parts.push(boldParts.join(' '));
      }
    }
    
    // Add other fields if present (frequency, status) without prefixes
    if (item.frequency) parts.push(item.frequency);
    if (item.status) parts.push(item.status);
    
    return parts.join(' ') || 'No details available';
  }
  // Generic format for other categories
  return JSON.stringify(item).substring(0, 100) || 'No details available';
};

const copyItemToClipboard = async (item: any, categoryName: string) => {
  if (categoryName.toLowerCase().includes('clinical notes')) {
    await copyNoteToClipboard(item);
    return;
  }
  
  // For other categories, create a search query using original item data
  // For medications, use the original item data (with all info) for clipboard
  let description = '';
  if (categoryName.toLowerCase().includes('medication')) {
    // Use original item data for clipboard (keep all information)
    const parts: string[] = [];
    if (item.date) parts.push(item.date);
    if (item.name) parts.push(item.name);
    if (item.dosage) parts.push(item.dosage);
    if (item.frequency) parts.push(item.frequency);
    if (item.status) parts.push(item.status);
    description = parts.join(' ');
  } else {
    // For other categories, use formatItemDescription and strip HTML tags
    description = formatItemDescription(item, categoryName);
    description = description.replace(/<[^>]*>/g, '');
  }
  
  const excludeFile = item.fileName ? ` (excluding ${item.fileName})` : '';
  const query = `Find information about: ${description} in your knowledge base${excludeFile} and return the filename and page number in that file.`;
  
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
    $q.notify({
      message: 'Failed to copy to clipboard',
      type: 'negative',
      position: 'top',
      timeout: 2000
    });
  }
};

const processInitialFile = async () => {
  isProcessing.value = true;
  error.value = '';
  pdfData.value = null;
  categories.value = [];
  markdownContent.value = '';

  try {
    console.log('Processing initial file for Lists extraction');
    
    const response = await fetch('/api/files/lists/process-initial-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include'
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}: ${response.statusText}` }));
      throw new Error(errorData.error || 'Failed to process initial file');
    }

    const data = await response.json();
    console.log('Initial file processing successful:', {
      totalPages: data.totalPages,
      pagesCount: data.pages?.length,
      markdownSaved: !!data.markdownBucketKey
    });
    
    pdfData.value = {
      totalPages: data.totalPages,
      pages: data.pages || [],
      categories: [],
      fullMarkdown: data.fullMarkdown || ''
    };
    markdownContent.value = data.fullMarkdown || '';
    markdownBucketKey.value = data.markdownBucketKey || null;
    selectedFileName.value = data.fileName || 'Initial File';
    hasSavedResults.value = true;
    
    // Store initial file info if available
    if (data.fileName) {
      // Get bucketKey from user-status if not in response
      if (!initialFileInfo.value) {
        const statusResponse = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, {
          credentials: 'include'
        });
        if (statusResponse.ok) {
          const statusResult = await statusResponse.json();
          if (statusResult.initialFile && statusResult.initialFile.bucketKey) {
            initialFileInfo.value = {
              bucketKey: statusResult.initialFile.bucketKey,
              fileName: data.fileName
            };
          }
        }
      } else {
        initialFileInfo.value.fileName = data.fileName;
      }
    }
    
    // Extract categories from markdown
    extractCategoriesFromMarkdown(data.fullMarkdown || '');
    
    if (data.markdownBucketKey) {
      savedPdfBucketKey.value = data.markdownBucketKey;
    }
    
    if (data.pages && data.pages.length > 0) {
      activePageTab.value = data.pages[0].page;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to process initial file';
    error.value = errorMessage;
    console.error('Initial file processing error:', err);
  } finally {
    isProcessing.value = false;
  }
};

const clearCachedLists = async () => {
  try {
    // Call backend to clear cached list files
    const response = await fetch('/api/files/lists/clear-cache', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include'
    });
    
    if (response.ok) {
      console.log('✅ Cleared cached list files');
      // Reset processing status
      categoryProcessingStatus.value = {};
      currentCategoryDisplay.value = null;
      categoryItems.value = [];
    }
  } catch (err) {
    console.warn('Failed to clear cached lists:', err);
    // Continue anyway - the cache will be invalidated by timestamp check
  }
};

// processPdfFile and processPdfFromBucket removed - replaced with processInitialFile

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

    // Update current category display and items
    currentCategoryDisplay.value = categoryName;
    categoryItems.value = result.list || [];

    // If it's Clinical Notes, also reload the clinical notes list for the existing component
    if (categoryName.toLowerCase().includes('clinical notes')) {
      loadClinicalNotes();
      // Also update categoryItems with clinical notes format
      categoryItems.value = result.list.map((note: any) => ({
        id: note.id || `${note.fileName}-${note.page}-${note.noteIndex || 0}`,
        ...note
      }));
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

const cleanupMarkdown = async () => {
  isCleaningMarkdown.value = true;
  try {
    const response = await fetch('/api/files/lists/cleanup-markdown', {
      method: 'POST',
      credentials: 'include'
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}: ${response.statusText}` }));
      throw new Error(errorData.error || 'Failed to cleanup markdown');
    }

    const result = await response.json();
    console.log(`✅ Markdown cleaned: ${result.pagesCleaned} page(s) cleaned`);
    
    // Reload the markdown to show cleaned version
    const markdownResponse = await fetch('/api/files/lists/markdown', {
      credentials: 'include'
    });
    
    if (markdownResponse.ok) {
      const markdownResult = await markdownResponse.json();
      if (markdownResult.hasMarkdown && markdownResult.markdown) {
        markdownContent.value = markdownResult.markdown;
        markdownBucketKey.value = markdownResult.markdownBucketKey || null;
        // Re-extract categories after cleanup
        extractCategoriesFromMarkdown(markdownResult.markdown);
      }
    }
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        message: `Markdown cleaned: ${result.pagesCleaned} page(s) cleaned`,
        type: 'positive',
        position: 'top',
        timeout: 3000
      });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to cleanup markdown';
    error.value = errorMessage;
    console.error('Markdown cleanup error:', err);
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        message: errorMessage,
        type: 'negative',
        position: 'top',
        timeout: 3000
      });
    }
  } finally {
    isCleaningMarkdown.value = false;
  }
};

// Extract unique categories from markdown (lines starting with "### ")
const extractCategoriesFromMarkdown = (markdown: string) => {
  if (!markdown) {
    categoriesList.value = [];
    return;
  }
  
  const lines = markdown.split('\n');
  const seenCategories = new Set<string>();
  const categories: Array<{ name: string; page: number }> = [];
  let currentPage = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check for page header: "## Page nn"
    const pageMatch = line.match(/^##\s+Page\s+(\d+)$/);
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10);
      continue;
    }
    
    // Check for category header: "### Category Name"
    if (line.startsWith('### ')) {
      const categoryName = line.substring(4).trim();
      
      // Only add if we haven't seen this category before
      if (categoryName && !seenCategories.has(categoryName)) {
        seenCategories.add(categoryName);
        categories.push({
          name: categoryName,
          page: currentPage || 1 // Default to page 1 if no page found yet
        });
      }
    }
  }
  
  categoriesList.value = categories;
  console.log(`📋 [LISTS] Extracted ${categories.length} unique categories from markdown`);
};

// Handle category page link click
const handleCategoryPageClick = (page: number) => {
  if (!initialFileInfo.value) {
    console.warn('No initial file info available for PDF viewing');
    return;
  }
  
  viewingPdfFile.value = {
    bucketKey: initialFileInfo.value.bucketKey,
    name: initialFileInfo.value.fileName
  };
  pdfInitialPage.value = page;
  showPdfViewer.value = true;
};

const downloadMarkdown = () => {
  const contentToDownload = markdownContent.value || (pdfData.value?.fullMarkdown);
  if (!contentToDownload) {
    error.value = 'No markdown content available to download';
    return;
  }

  try {
    // Create a blob with the markdown content
    const blob = new Blob([contentToDownload], { type: 'text/markdown' });
    
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
  checkInitialFile();
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

