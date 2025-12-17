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

    <!-- Current Medications -->
    <q-card v-if="currentMedications !== null" class="q-mb-md">
      <q-card-section>
        <div class="text-h6 q-mb-md">Current Medications</div>
        
        <!-- Display Mode -->
        <div v-if="!isEditingCurrentMedications" class="text-body2" style="white-space: pre-wrap;">{{ currentMedications }}</div>
        
        <!-- Edit Mode -->
        <div v-else>
          <textarea 
            v-model="editingCurrentMedications" 
            rows="8"
            class="full-width q-pa-sm"
            style="border: 1px solid #ccc; border-radius: 4px; resize: vertical; font-family: inherit;"
          />
          <div class="q-mt-sm">
            <q-btn
              size="sm"
              icon="save"
              color="primary"
              label="Save"
              @click="saveCurrentMedications"
              :loading="isSavingCurrentMedications"
            />
            <q-btn
              size="sm"
              icon="close"
              color="grey-7"
              label="Cancel"
              @click="cancelEditingCurrentMedications"
              class="q-ml-sm"
            />
          </div>
        </div>
        
        <div class="q-mt-sm">
          <q-btn
            v-if="!isEditingCurrentMedications"
            flat
            dense
            icon="edit"
            label="Edit"
            @click="startEditingCurrentMedications"
            class="q-mr-sm"
          />
          <q-btn
            v-if="hasMedicationRecords && !isEditingCurrentMedications"
            flat
            dense
            icon="refresh"
            label="Refresh"
            @click="handleRefreshCurrentMedications"
            :loading="isLoadingCurrentMedications"
          />
        </div>
      </q-card-section>
    </q-card>

    <!-- Refresh Confirmation Dialog -->
    <q-dialog v-model="showRefreshConfirmDialog" persistent>
      <q-card style="min-width: 350px">
        <q-card-section>
          <div class="text-h6">Confirm Refresh</div>
        </q-card-section>
        <q-card-section>
          You will need to review and edit your current medications again.
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="CANCEL" color="grey-7" v-close-popup />
          <q-btn flat label="REFRESH" color="primary" @click="confirmRefreshCurrentMedications" />
        </q-card-actions>
      </q-card>
    </q-dialog>

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

      <!-- Categories Section -->
      <q-card v-if="categoriesList.length > 0" class="q-mb-md">
        <q-card-section>
          <div class="text-h6 q-mb-md">Categories</div>
          <q-list bordered separator>
            <q-expansion-item
              v-for="(category, index) in categoriesList" 
              :key="index"
              :label="category.name"
              :default-opened="category.expanded"
              @show="expandedCategories.add(category.name)"
              @hide="expandedCategories.delete(category.name)"
              header-class="text-primary"
            >
              <template v-slot:header>
                <q-item-section>
                  <q-item-label>{{ category.name }}</q-item-label>
                  <q-item-label caption>
                    starts on 
                    <a 
                      href="#" 
                      @click.stop.prevent="handleCategoryPageClick(category.page)"
                      class="text-primary"
                      style="text-decoration: underline; cursor: pointer;"
                    >
                      page {{ category.page }}
                    </a>
                    <span v-if="category.observationCount > 0" class="q-ml-sm">
                      • {{ category.observationCount }} Observation{{ category.observationCount !== 1 ? 's' : '' }}
                    </span>
                  </q-item-label>
                </q-item-section>
              </template>
              
              <q-card>
                <q-card-section>
                  <q-list dense>
                    <template v-for="(obs, obsIndex) in category.observations" :key="obsIndex">
                      <q-item class="q-px-sm">
                        <q-item-section>
                          <q-item-label class="text-body2">
                            <span 
                              v-html="obs.display.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')"
                              @click="handleObservationClick($event, obs.page)"
                            ></span>
                          </q-item-label>
                        </q-item-section>
                      </q-item>
                      <!-- Display out of range lines for Lab Results -->
                      <q-item 
                        v-for="(oorLine, oorIndex) in obs.outOfRangeLines" 
                        :key="`oor-${obsIndex}-${oorIndex}`"
                        class="q-px-sm q-pl-lg"
                      >
                        <q-item-section>
                          <q-item-label class="text-body2 text-negative">
                            {{ fixOutOfRangeText(oorLine.trim()) }}
                          </q-item-label>
                        </q-item-section>
                      </q-item>
                    </template>
                  </q-list>
                </q-card-section>
              </q-card>
            </q-expansion-item>
          </q-list>
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
import { ref, computed, onMounted, watch, onActivated } from 'vue';
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
const categoriesList = ref<Array<{ 
  name: string; 
  page: number; 
  observationCount: number; 
  startLine?: number; 
  endLine?: number;
  observations?: Array<{ date: string; display: string; page?: number; lineCount?: number; outOfRangeLines?: string[] }>;
  expanded?: boolean;
}>>([]);
const expandedCategories = ref<Set<string>>(new Set());
const showPdfViewer = ref(false);
const viewingPdfFile = ref<{ bucketKey?: string; name?: string; fileUrl?: string; originalFile?: File } | undefined>(undefined);
const pdfInitialPage = ref<number | undefined>(undefined);
const currentMedications = ref<string | null>(null);
const isLoadingCurrentMedications = ref(false);
const isEditingCurrentMedications = ref(false);
const editingCurrentMedications = ref('');
const editingOriginalCurrentMedications = ref('');
const isSavingCurrentMedications = ref(false);
const isCurrentMedicationsEdited = ref(false);
const showRefreshConfirmDialog = ref(false);

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
        markdownBucketKey.value = markdownResult.markdownBucketKey || null;
        hasSavedResults.value = true;
        
        // Load initial file info if not already loaded
        if (!initialFileInfo.value) {
          await checkInitialFile();
        }
        
        // FIRST PASS: Extract categories and label ALL [D+P] lines (returns modified markdown)
        const markedMarkdown = extractCategoriesFromMarkdown(markdownResult.markdown);
        markdownContent.value = markedMarkdown;
        
        // SECOND PASS: Count [D+P] lines for each category
        countObservationsByPageRange(markdownContent.value);
        
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
    
    pdfData.value = {
      totalPages: data.totalPages,
      pages: data.pages || [],
      categories: [],
      fullMarkdown: data.fullMarkdown || ''
    };
    
    const fullMarkdown = data.fullMarkdown || '';
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
    
    // FIRST PASS: Extract categories and label ALL [D+P] lines (returns modified markdown)
    const markedMarkdown = extractCategoriesFromMarkdown(fullMarkdown);
    markdownContent.value = markedMarkdown;
    
    // SECOND PASS: Count [D+P] lines for each category
    countObservationsByPageRange(markedMarkdown);
    
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
    
    // Reload the markdown to show cleaned version
    const markdownResponse = await fetch('/api/files/lists/markdown', {
      credentials: 'include'
    });
    
    if (markdownResponse.ok) {
      const markdownResult = await markdownResponse.json();
      if (markdownResult.hasMarkdown && markdownResult.markdown) {
        markdownBucketKey.value = markdownResult.markdownBucketKey || null;
        // FIRST PASS: Re-extract categories and label ALL [D+P] lines (returns modified markdown)
        const markedMarkdown = extractCategoriesFromMarkdown(markdownResult.markdown);
        markdownContent.value = markedMarkdown;
        
        // SECOND PASS: Count [D+P] lines for each category
        countObservationsByPageRange(markdownContent.value);
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
// Labels ALL [D+P] lines with category name and tracks category boundaries
const extractCategoriesFromMarkdown = (markdown: string) => {
  if (!markdown) {
    categoriesList.value = [];
    return markdown;
  }
  
  const lines = markdown.split('\n');
  const categoryMap = new Map<string, { name: string; page: number; observationCount: number; startLine: number; endLine: number }>();
  const dateLocationPattern = /^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\S+/i;
  
  // Build page boundary map: page number -> line index
  const pageBoundaries = new Map<number, number>();
  
  // Track category boundaries: category name -> { startLine, endLine }
  // For categories that appear multiple times, track the first start and last end
  const categoryBoundaries = new Map<string, { startLine: number; endLine: number }>();
  
  // Track which categories have had their first [D+P] line labeled
  const categoryFirstDPlusLabeled = new Map<string, boolean>();
  
  // FIRST PASS: Find ALL categories, label first [D+P] line in each category, and track category boundaries
  let currentPage = 0;
  let currentCategory: string | null = null;
  let currentCategoryStartLine = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const originalLine = lines[i];
    
    // Check for page header: "## Page nn"
    const pageMatch = line.match(/^##\s+Page\s+(\d+)$/);
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10);
      pageBoundaries.set(currentPage, i);
      continue;
    }
    
    // Check for category header: "### Category Name"
    if (line.startsWith('### ')) {
      // Close previous category if exists
      if (currentCategory && currentCategoryStartLine >= 0) {
        const existing = categoryBoundaries.get(currentCategory);
        if (existing) {
          // Update end line if this is later
          existing.endLine = i - 1;
        } else {
          // First occurrence of this category
          categoryBoundaries.set(currentCategory, {
            startLine: currentCategoryStartLine,
            endLine: i - 1
          });
        }
      }
      
      const categoryName = line.substring(4).trim();
      currentCategory = categoryName;
      currentCategoryStartLine = i;
      
      // Add ALL categories to the map (only once per unique category name)
      if (categoryName && !categoryMap.has(categoryName)) {
        categoryMap.set(categoryName, {
          name: categoryName,
          page: currentPage || 1,
          observationCount: 0,
          startLine: i,
          endLine: lines.length - 1 // Will be updated when category ends
        });
        // Initialize boundary tracking
        categoryBoundaries.set(categoryName, {
          startLine: i,
          endLine: lines.length - 1
        });
        // Initialize first [D+P] labeled flag (only once per unique category)
        categoryFirstDPlusLabeled.set(categoryName, false);
      } else if (categoryName && categoryMap.has(categoryName)) {
        // Category already exists - update start line if this is earlier
        const existing = categoryBoundaries.get(categoryName);
        if (existing && i < existing.startLine) {
          existing.startLine = i;
        }
        // Don't reset flag - we only want to label the FIRST [D+P] line once per category
      }
      continue;
    }
    
    // Label ONLY the first [D+P] line in each unique category with category name
    // Label all other [D+P] lines with just [D+P] prefix
    if (currentCategory) {
      // Check if this line matches Date + Place pattern (and not already marked)
      if (!line.startsWith('[D+P] ') && dateLocationPattern.test(line)) {
        const isFirstDPlus = !categoryFirstDPlusLabeled.get(currentCategory);
        if (isFirstDPlus) {
          // Label ONLY the first [D+P] line with category name (once per unique category)
          lines[i] = `[D+P] ${currentCategory} ${originalLine}`;
          categoryFirstDPlusLabeled.set(currentCategory, true);
        } else {
          // Label all other [D+P] lines with just [D+P] prefix
          lines[i] = `[D+P] ${originalLine}`;
        }
      }
    }
  }
  
  // Close last category if exists
  if (currentCategory && currentCategoryStartLine >= 0) {
    const existing = categoryBoundaries.get(currentCategory);
    if (existing) {
      existing.endLine = lines.length - 1;
    } else {
      categoryBoundaries.set(currentCategory, {
        startLine: currentCategoryStartLine,
        endLine: lines.length - 1
      });
    }
  }
  
  // Update categoryMap with boundaries
  for (const [categoryName, boundaries] of categoryBoundaries.entries()) {
    if (categoryMap.has(categoryName)) {
      const category = categoryMap.get(categoryName)!;
      category.startLine = boundaries.startLine;
      category.endLine = boundaries.endLine;
    }
  }
  
  // Convert map to array
  categoriesList.value = Array.from(categoryMap.values());
  
  // Return modified markdown with ALL [D+P] lines labeled
  return lines.join('\n');
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

// Handle observation click (for Clinical Vitals line count links)
const handleObservationClick = (event: Event, page?: number) => {
  const target = event.target as HTMLElement;
  // Check if clicked element is a link with data-page attribute
  if (target.tagName === 'A' && target.getAttribute('data-page') && page) {
    event.preventDefault();
    handleCategoryPageClick(page);
  }
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

// Find page number for a given line index
const findPageForLine = (lineIndex: number, lines: string[]): number => {
  let currentPage = 1;
  for (let i = 0; i <= lineIndex && i < lines.length; i++) {
    const line = lines[i].trim();
    const pageMatch = line.match(/^##\s+Page\s+(\d+)$/);
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10);
    }
  }
  return currentPage;
};

// Fix "OUT OF RANGE" text that may have encoding issues with the E in RANGE
const fixOutOfRangeText = (text: string): string => {
  // Replace variations of "RANG" followed by any character with "RANGE"
  // This handles cases where "RANGE" is displayed as "RANG*" or "RANG?" etc.
  return text.replace(/RANG[^\s]/gi, 'RANGE');
};

// Extract observations for a category based on its type
const extractObservationsForCategory = (
  categoryName: string,
  startLine: number,
  endLine: number,
  lines: string[]
): Array<{ date: string; display: string; page?: number; lineCount?: number }> => {
  const observations: Array<{ date: string; display: string; page?: number; lineCount?: number }> = [];
  const categoryLower = categoryName.toLowerCase();
  
  // For Clinical Vitals and Lab Results, track observations by date to merge duplicates
  const shouldMergeByDate = categoryLower.includes('clinical vitals') || categoryLower.includes('lab result');
  const mergedByDate = new Map<string, { lineCount: number; page?: number; outOfRangeLines?: string[] }>();
  
  let currentObservationStart = -1;
  let currentDate = '';
  let dPlusCount = 0;
  
  for (let i = startLine; i <= endLine && i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check if this is a [D+P] line (start of new observation)
    if (line.startsWith('[D+P] ')) {
      dPlusCount++;
      // Save previous observation if exists
      if (currentObservationStart >= 0 && currentDate) {
        const obsLines = lines.slice(currentObservationStart, i);
        const page = findPageForLine(currentObservationStart, lines);
        
        // For Lab Results, track lines with "OUT   OF   RANG*"
        let outOfRangeLines: string[] = [];
        if (categoryLower.includes('lab result')) {
          outOfRangeLines = obsLines.filter(l => l.includes('OUT') && l.includes('OF') && l.includes('RANG'));
        }
        
        if (shouldMergeByDate) {
          // For Clinical Vitals and Lab Results, merge observations with same date
          const existing = mergedByDate.get(currentDate);
          if (existing) {
            existing.lineCount += obsLines.length;
            // Merge out of range lines
            if (categoryLower.includes('lab result') && outOfRangeLines.length > 0) {
              if (!existing.outOfRangeLines) {
                existing.outOfRangeLines = [];
              }
              existing.outOfRangeLines.push(...outOfRangeLines);
            }
            // Keep the first page encountered for this date
          } else {
            mergedByDate.set(currentDate, { 
              lineCount: obsLines.length, 
              page,
              outOfRangeLines: categoryLower.includes('lab result') ? outOfRangeLines : undefined
            });
          }
        } else {
          // For other categories, create separate observations
          const display = formatObservation(categoryName, currentDate, obsLines, lines, i, page);
          if (display) {
            observations.push({ 
              date: currentDate, 
              display, 
              page, 
              lineCount: obsLines.length,
              outOfRangeLines: categoryLower.includes('lab result') && outOfRangeLines.length > 0 ? outOfRangeLines : undefined
            });
          }
        }
      }
      
      // Extract date from [D+P] line
      const dateMatch = line.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
      if (dateMatch) {
        currentDate = dateMatch[1];
        currentObservationStart = i;
      }
    }
  }
  
  // Save last observation
  if (currentObservationStart >= 0 && currentDate) {
    const obsLines = lines.slice(currentObservationStart, endLine + 1);
    const page = findPageForLine(currentObservationStart, lines);
    
    // For Lab Results, track lines with "OUT   OF   RANG*"
    let outOfRangeLines: string[] = [];
    if (categoryLower.includes('lab result')) {
      outOfRangeLines = obsLines.filter(l => l.includes('OUT') && l.includes('OF') && l.includes('RANG'));
    }
    
    if (shouldMergeByDate) {
      // For Clinical Vitals and Lab Results, merge observations with same date
      const existing = mergedByDate.get(currentDate);
      if (existing) {
        existing.lineCount += obsLines.length;
        // Merge out of range lines
        if (categoryLower.includes('lab result') && outOfRangeLines.length > 0) {
          if (!existing.outOfRangeLines) {
            existing.outOfRangeLines = [];
          }
          existing.outOfRangeLines.push(...outOfRangeLines);
        }
      } else {
        mergedByDate.set(currentDate, { 
          lineCount: obsLines.length, 
          page,
          outOfRangeLines: categoryLower.includes('lab result') && outOfRangeLines.length > 0 ? outOfRangeLines : undefined
        });
      }
    } else {
      // For other categories, create separate observations
      const display = formatObservation(categoryName, currentDate, obsLines, lines, endLine + 1, page);
      if (display) {
        observations.push({ 
          date: currentDate, 
          display, 
          page, 
          lineCount: obsLines.length,
          outOfRangeLines: categoryLower.includes('lab result') && outOfRangeLines.length > 0 ? outOfRangeLines : undefined
        });
      }
    }
  }
  
  // For Clinical Vitals and Lab Results, convert merged dates to observations
  if (shouldMergeByDate) {
    for (const [date, data] of mergedByDate.entries()) {
      const display = formatObservation(categoryName, date, [], lines, 0, data.page, data.lineCount);
      if (display) {
        observations.push({ 
          date, 
          display, 
          page: data.page, 
          lineCount: data.lineCount,
          outOfRangeLines: data.outOfRangeLines
        });
      }
    }
  }
  
  // Special handling for Allergies: if no [D+P] lines found, treat entire category as one observation
  if (categoryLower.includes('allerg') && dPlusCount === 0 && endLine > startLine) {
    const allLines = lines.slice(startLine, endLine + 1);
    const page = findPageForLine(startLine, lines);
    // For Allergies, don't use a date - just use empty string
    const allergyDate = '';
    const display = formatObservation(categoryName, allergyDate, allLines, lines, endLine + 1, page);
    if (display && allLines.length > 1) {
      observations.push({ date: allergyDate, display, page });
    }
  }
  
  return observations;
};

// Format observation display based on category type
const formatObservation = (
  categoryName: string,
  date: string,
  obsLines: string[],
  allLines: string[],
  nextDPlusIndex: number,
  page?: number,
  lineCount?: number
): string => {
  const categoryLower = categoryName.toLowerCase();
  
  if (categoryLower.includes('allerg')) {
    // Allergies: Display only lines that look like allergy entries (e.g., "SULFA ...")
    // Filter out category headers (###), page headers (##), and other non-allergy lines
    if (obsLines.length >= 1) {
      // Filter to only include lines that look like allergy entries
      // These typically start with uppercase letters and contain allergy information
      const allergyLines = obsLines.filter(line => {
        const trimmed = line.trim();
        // Skip empty lines, category headers, and page headers
        if (!trimmed || trimmed.startsWith('###') || trimmed.startsWith('## ')) {
          return false;
        }
        // Include lines that start with uppercase letters (like "SULFA")
        // and don't look like metadata or headers
        const firstChar = trimmed.charAt(0);
        return firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase();
      });
      
      if (allergyLines.length > 0) {
        const formattedLines = allergyLines.map(line => {
          const trimmed = line.trim();
          // Get first word and rest of line
          const firstSpaceIndex = trimmed.indexOf(' ');
          if (firstSpaceIndex > 0) {
            const firstWord = trimmed.substring(0, firstSpaceIndex);
            const rest = trimmed.substring(firstSpaceIndex + 1);
            return `**${firstWord}** ${rest}`;
          }
          // If no space, just bold the whole line
          return `**${trimmed}**`;
        });
        
        if (formattedLines.length > 0) {
          // If date is empty, don't include it in the display
          return date ? `${date} ${formattedLines.join(' ')}` : formattedLines.join(' ');
        }
      }
    }
    return date;
  } else if (categoryLower.includes('medication')) {
    // Medications: Date + medication name + dose (both in bold)
    if (obsLines.length > 1) {
      const nextLine = obsLines[1]?.trim() || '';
      const parts = nextLine.split(/\s+/);
      if (parts.length >= 2) {
        const medicationName = parts[0];
        const dose = parts.slice(1).join(' ');
        return `${date} **${medicationName}** **${dose}**`;
      }
      return `${date} **${nextLine}**`;
    }
    return date;
  } else if (categoryLower.includes('clinical notes')) {
    // Clinical Notes: Date + observation name (Line 1 of 5) + Author (Line 2 of 5) both in bold
    // Structure: [D+P] line (index 0), Line 1 = Type, Line 2 = Author, Line 3 = Category, Line 4 = Created, Line 5 = Status
    if (obsLines.length >= 3) {
      // Line 1 of 5 is at index 1 (after [D+P] line at index 0)
      const typeLine = obsLines[1]?.trim() || '';
      // Line 2 of 5 is at index 2
      const authorLine = obsLines[2]?.trim() || '';
      
      // Clean up the lines - remove any "Type:" or "Author:" prefixes if present
      let type = typeLine.replace(/^Type:\s*/i, '').trim();
      let author = authorLine.replace(/^Author:\s*/i, '').trim();
      
      // If still empty, use the raw line
      if (!type) type = typeLine;
      if (!author) author = authorLine;
      
      return `${date} **${type || 'N/A'}** by **${author || 'N/A'}**`;
    } else if (obsLines.length >= 2) {
      // Fallback if structure is different - at least try to get first line
      const typeLine = obsLines[1]?.trim() || '';
      return `${date} **${typeLine || 'N/A'}** by **N/A**`;
    }
    return date;
  } else if (categoryLower.includes('procedure') || 
             categoryLower.includes('condition') || 
             categoryLower.includes('immunization')) {
    // Procedures, Conditions, Immunizations: Date + entire line following [D+P] (in bold)
    if (obsLines.length > 1) {
      let nextLine = obsLines[1]?.trim() || '';
      // For Procedures, remove "## " from the start if present
      if (categoryLower.includes('procedure') && nextLine.startsWith('## ')) {
        nextLine = nextLine.substring(3).trim();
      }
      return `${date} **${nextLine}**`;
    }
    return date;
  } else if (categoryLower.includes('clinical vitals') || 
             categoryLower.includes('lab result')) {
    // Clinical Vitals, Lab Results: Date + total number of lines in observation (clickable if page available)
    // Use provided lineCount if available (for merged Clinical Vitals), otherwise use obsLines.length
    const count = lineCount ?? obsLines.length;
    if (page && (categoryLower.includes('clinical vitals') || categoryLower.includes('lab result'))) {
      // Make line count clickable for Clinical Vitals and Lab Results
      return `${date} (<a href="#" class="text-primary" style="text-decoration: underline; cursor: pointer;" data-page="${page}">${count} line${count !== 1 ? 's' : ''}</a>)`;
    }
    return `${date} (${count} line${count !== 1 ? 's' : ''})`;
  }
  
  // Default: just show date
  return date;
};

// SECOND PASS: Count [D+P] lines for each category using category boundaries from FIRST PASS
const countObservationsByPageRange = (markedMarkdown: string): void => {
  const lines = markedMarkdown.split('\n');
  
  // Process each category using boundaries calculated in FIRST PASS
  categoriesList.value = categoriesList.value.map(category => {
    const categoryName = category.name;
    const startLine = category.startLine ?? 0;
    const endLine = category.endLine ?? lines.length - 1;
    
    // Count [D+P] lines in this category's range
    let dPlusCount = 0;
    let firstDPlusLine: string | null = null;
    let firstDPlusDate: string | null = null;
    
    // Scan only the lines for this category
    for (let i = startLine; i <= endLine && i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Check if this is a [D+P] line
      // First [D+P] line will have category name: "[D+P] <category name> <date and place>"
      // Other [D+P] lines will just have: "[D+P] <date and place>"
      if (line.startsWith(`[D+P] ${categoryName} `)) {
        // This is the first [D+P] line with category label
        dPlusCount++;
        
        // Extract date from first [D+P] line
        if (firstDPlusLine === null) {
          firstDPlusLine = line;
          // Extract date (format: "Mon DD, YYYY")
          // Pattern: after category name, find date
          const dateMatch = line.match(/\[D\+P\]\s+\S+\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
          if (dateMatch) {
            firstDPlusDate = dateMatch[1];
          }
        }
      } else if (line.startsWith('[D+P] ') && !line.startsWith(`[D+P] ${categoryName} `)) {
        // Check if this is a [D+P] line without category label (subsequent ones)
        // Pattern: "[D+P] <date and place>" - date pattern after [D+P]
        const datePattern = /^\[D\+P\]\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\S+)/;
        if (datePattern.test(line)) {
          // This is a [D+P] line without category label (subsequent ones in this category)
          dPlusCount++;
          
          // Extract date from first [D+P] line if not already found
          if (firstDPlusLine === null) {
            firstDPlusLine = line;
            const dateMatch = line.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
            if (dateMatch) {
              firstDPlusDate = dateMatch[1];
            }
          }
        }
      }
    }
    
    // Extract observations for this category
    const observations = extractObservationsForCategory(categoryName, startLine, endLine, lines);
    
    return {
      ...category,
      observationCount: dPlusCount,
      observations: observations,
      expanded: expandedCategories.value.has(categoryName)
    };
  });
  
  // After processing categories, load current medications if Medication Records exist (only if not already edited)
  if (!isCurrentMedicationsEdited.value) {
    const medicationCategory = categoriesList.value.find(cat => 
      cat.name.toLowerCase().includes('medication')
    );
    if (medicationCategory && medicationCategory.observations && medicationCategory.observations.length > 0) {
      loadCurrentMedications();
    }
  }
};


// Reload categories and observations whenever markdown content is available
const reloadCategories = async () => {
  if (markdownContent.value) {
    // FIRST PASS: Extract categories and label ALL [D+P] lines (returns modified markdown)
    const markedMarkdown = extractCategoriesFromMarkdown(markdownContent.value);
    markdownContent.value = markedMarkdown;
    
    // SECOND PASS: Count [D+P] lines for each category
    countObservationsByPageRange(markdownContent.value);
  } else {
    // If no markdown in memory, fetch it
    await loadSavedResults();
    
    // After loading, extract categories and mark the lines
    if (markdownContent.value) {
      // FIRST PASS: Extract categories and label ALL [D+P] lines (returns modified markdown)
      const markedMarkdown = extractCategoriesFromMarkdown(markdownContent.value);
      markdownContent.value = markedMarkdown;
      
      // SECOND PASS: Count [D+P] lines for each category
      countObservationsByPageRange(markdownContent.value);
    }
  }
};

onMounted(() => {
  checkInitialFile();
  loadClinicalNotes();
  loadSavedResults(); // Check for saved results first
});

// Load current medications from user document or Medication Records
const loadCurrentMedications = async (forceRefresh = false) => {
  // If already edited and not forcing refresh, don't overwrite
  if (isCurrentMedicationsEdited.value && !forceRefresh) {
    return;
  }

  // First try to load from user document
  if (!forceRefresh) {
    try {
      const statusResponse = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, {
        credentials: 'include'
      });
      if (statusResponse.ok) {
        const statusResult = await statusResponse.json();
        if (statusResult.currentMedications) {
          currentMedications.value = statusResult.currentMedications;
          isCurrentMedicationsEdited.value = true; // Mark as edited since it came from user doc
          return;
        }
      }
    } catch (err) {
      console.warn('Error loading current medications from user document:', err);
    }
  }

  // Find Medication Records category
  const medicationCategory = categoriesList.value.find(cat => 
    cat.name.toLowerCase().includes('medication')
  );

  if (!medicationCategory || !medicationCategory.observations || medicationCategory.observations.length === 0) {
    currentMedications.value = null;
    return;
  }

  isLoadingCurrentMedications.value = true;
  try {
    const response = await fetch('/api/files/lists/current-medications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        medicationRecords: medicationCategory.observations
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || 'Failed to get current medications');
    }

    const result = await response.json();
    if (result.success && result.currentMedications) {
      currentMedications.value = result.currentMedications;
      isCurrentMedicationsEdited.value = false; // Reset edited flag when loading from AI
    } else {
      currentMedications.value = null;
    }
  } catch (err) {
    console.error('Error loading current medications:', err);
    currentMedications.value = null;
  } finally {
    isLoadingCurrentMedications.value = false;
  }
};

// Start editing current medications
const startEditingCurrentMedications = () => {
  isEditingCurrentMedications.value = true;
  editingCurrentMedications.value = currentMedications.value || '';
  editingOriginalCurrentMedications.value = currentMedications.value || '';
};

// Cancel editing current medications
const cancelEditingCurrentMedications = () => {
  isEditingCurrentMedications.value = false;
  editingCurrentMedications.value = '';
  editingOriginalCurrentMedications.value = '';
};

// Save current medications to user document
const saveCurrentMedications = async () => {
  isSavingCurrentMedications.value = true;
  try {
    const response = await fetch('/api/user-current-medications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        currentMedications: editingCurrentMedications.value
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || 'Failed to save current medications');
    }

    currentMedications.value = editingCurrentMedications.value;
    isCurrentMedicationsEdited.value = true;
    isEditingCurrentMedications.value = false;
    editingCurrentMedications.value = '';
    editingOriginalCurrentMedications.value = '';
  } catch (err) {
    console.error('Error saving current medications:', err);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to save current medications',
        timeout: 3000
      });
    }
  } finally {
    isSavingCurrentMedications.value = false;
  }
};

// Handle refresh click - show confirmation if edited
const handleRefreshCurrentMedications = () => {
  if (isCurrentMedicationsEdited.value) {
    showRefreshConfirmDialog.value = true;
  } else {
    loadCurrentMedications(true);
  }
};

// Confirm refresh - proceed with refresh
const confirmRefreshCurrentMedications = () => {
  showRefreshConfirmDialog.value = false;
  isCurrentMedicationsEdited.value = false;
  loadCurrentMedications(true);
};

// Computed property to check if we have medication records
const hasMedicationRecords = computed(() => {
  const medicationCategory = categoriesList.value.find(cat => 
    cat.name.toLowerCase().includes('medication')
  );
  return medicationCategory && medicationCategory.observations && medicationCategory.observations.length > 0;
});

// Reload categories when component is activated (if using KeepAlive)
onActivated(() => {
  reloadCategories();
});

// Watch for markdown content changes and reload categories
watch(markdownContent, (newContent) => {
  if (newContent) {
    // FIRST PASS: Extract categories and label ALL [D+P] lines (returns modified markdown)
    const markedMarkdown = extractCategoriesFromMarkdown(newContent);
    markdownContent.value = markedMarkdown;
    
    // SECOND PASS: Count [D+P] lines for each category
    countObservationsByPageRange(markdownContent.value);
  }
});

// Expose method to reload categories (can be called from parent)
// Must be after reloadCategories is defined
defineExpose({
  reloadCategories
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

