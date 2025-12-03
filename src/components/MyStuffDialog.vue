<template>
  <q-dialog v-model="isOpen" persistent>
    <q-card style="width: 90vw; height: 90vh; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column;">
      <q-card-section class="row items-center q-pb-none" style="flex-shrink: 0;">
        <div class="text-h5">My Stuff</div>
        <q-space />
        <q-btn icon="close" flat round dense @click="closeDialog" />
      </q-card-section>

      <q-card-section style="flex: 1; overflow-y: auto; min-height: 0;">
        <q-tabs 
          v-model="currentTab" 
          class="text-grey bg-grey-3 rounded-borders"
          active-color="primary" 
          indicator-color="primary" 
          align="justify" 
          style="flex-shrink: 0;"
          dense
        >
          <q-tab name="files" label="Saved Files" icon="description" />
          <q-tab name="agent" label="My AI Agent" icon="smart_toy" />
          <q-tab name="chats" label="Saved Chats" icon="chat" />
          <q-tab name="summary" label="Patient Summary" icon="description" />
          <q-tab name="lists" label="My Lists" icon="list" />
          <q-tab name="privacy" label="Privacy Filter" icon="privacy_tip" />
          <q-tab name="diary" label="Patient Diary" icon="book" />
          <q-tab name="references" label="SHARED REFERENCES" icon="link" />
        </q-tabs>

        <q-tab-panels v-model="currentTab" animated>
          <!-- Saved Files Tab -->
          <q-tab-panel name="files">
            <div v-if="loadingFiles" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading files...</div>
            </div>

            <div v-else-if="filesError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ filesError }}</div>
              <q-btn label="Retry" color="primary" @click="loadFiles" class="q-mt-md" />
            </div>

            <div v-else-if="userFiles.length === 0" class="text-center q-pa-md text-grey">
              <q-icon name="folder_open" size="3em" />
              <div class="q-mt-sm">No files found</div>
            </div>

            <div v-else class="q-mt-md">
              <q-list>
                <q-item v-for="file in userFiles" :key="file.bucketKey" class="q-pa-md">
                  <q-item-section avatar>
                    <div class="row items-center q-gutter-xs">
                      <q-checkbox
                        v-model="file.inKnowledgeBase"
                        @update:model-value="onCheckboxChange(file)"
                        :disable="updatingFiles.has(file.bucketKey) || indexingKB"
                      />
                      <q-spinner
                        v-if="updatingFiles.has(file.bucketKey)"
                        size="20px"
                        color="primary"
                      />
                    </div>
                  </q-item-section>
                  <q-item-section>
                    <q-item-label 
                      class="cursor-pointer text-primary"
                      @click="viewFileInPdfViewer(file)"
                    >
                      {{ file.fileName }}
                    </q-item-label>
                    <q-item-label caption>
                      {{ formatFileSize(file.fileSize) }} • Uploaded {{ formatDate(file.uploadedAt) }}
                      <span v-if="updatingFiles.has(file.bucketKey)" class="q-ml-sm text-primary">
                        Moving file...
                      </span>
                    </q-item-label>
                  </q-item-section>
                  <q-item-section side>
                    <div class="row items-center q-gutter-xs">
                      <!-- Not in KB - show amber "Add to Knowledge Base" -->
                      <q-chip
                        v-if="!file.inKnowledgeBase"
                        color="amber"
                        text-color="white"
                        size="sm"
                        clickable
                        @click="file.inKnowledgeBase = true; onCheckboxChange(file)"
                      >
                        Add to Knowledge Base
                      </q-chip>
                      <!-- In KB but not indexed - show warning "Needs Indexing" -->
                      <q-chip
                        v-else-if="file.inKnowledgeBase && !isFileIndexed(file.bucketKey)"
                        color="orange"
                        text-color="white"
                        size="sm"
                        clickable
                        @click="file.inKnowledgeBase = false; onCheckboxChange(file)"
                      >
                        Needs Indexing
                      </q-chip>
                      <!-- In KB and indexed - show primary "Indexed in Knowledge Base" -->
                      <q-chip
                        v-else
                        color="primary"
                        text-color="white"
                        size="sm"
                        clickable
                        @click="file.inKnowledgeBase = false; onCheckboxChange(file)"
                      >
                        Indexed in Knowledge Base
                      </q-chip>
                      <q-btn
                        flat
                        round
                        dense
                        icon="delete"
                        color="negative"
                        @click="confirmDeleteFile(file)"
                        title="Delete file"
                      />
                    </div>
                  </q-item-section>
                </q-item>
              </q-list>
              
              <div v-if="kbNeedsUpdate || hasCheckboxChanges || kbIndexingOutOfSync" class="q-mt-md q-pt-md" style="border-top: 1px solid #e0e0e0;">
                <div v-if="kbNeedsUpdate || hasCheckboxChanges" class="q-mb-md text-body2 text-amber-9">
                  You have changed the files to be indexed into your knowledge base. Click "Update and Index KB" when ready.
                </div>
                <div v-else-if="kbIndexingOutOfSync && !hasCheckboxChanges" class="q-mb-md text-body2 text-amber-9">
                  You have changed the files to be indexed into your knowledge base. Click to index when ready.
                </div>
                <div class="row q-gutter-sm">
                <q-btn
                  label="Update and Index KB"
                  color="primary"
                  @click="updateAndIndexKB"
                    :disable="indexingKB || resettingKB"
                  :loading="indexingKB"
                />
                  <q-btn
                    v-if="isDevelopment"
                    label="RESET KB"
                    color="negative"
                    outline
                    @click="resetKB"
                    :disable="indexingKB || resettingKB"
                    :loading="resettingKB"
                  />
                </div>
              </div>
              
              <!-- Phase 1: Moving files -->
              <div v-if="indexingKB && indexingStatus.phase === 'moving'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Moving files to knowledge base folder...' }}</div>
              </div>

              <!-- Phase 2: KB Setup -->
              <div v-if="indexingKB && indexingStatus.phase === 'kb_setup'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Setting up knowledge base...' }}</div>
                <div v-if="indexingStatus.kb" class="text-caption text-grey-7 q-mt-xs">KB: {{ indexingStatus.kb }}</div>
              </div>

              <!-- Phase 3: Indexing Started -->
              <div v-if="indexingKB && indexingStatus.phase === 'indexing_started'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Indexing job started...' }}</div>
                <div class="text-caption text-grey-7 q-mt-xs">This may take several minutes</div>
              </div>

              <!-- Phase 4: Indexing In Progress -->
              <div v-if="indexingKB && indexingStatus.phase === 'indexing'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress 
                  :value="indexingStatus.progress || 0" 
                  color="primary" 
                  animated
                  class="q-mb-sm"
                />
                <div class="text-body2">Indexing in progress...</div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  <span v-if="indexingStatus.kb">KB: {{ indexingStatus.kb }} • </span>
                  <span v-if="indexingElapsedTime">Time: {{ indexingElapsedTime }} • </span>
                  Files: {{ indexingStatus.filesIndexed || 0 }} • 
                  Tokens: {{ indexingStatus.tokens || 'Calculating...' }}
                </div>
                <div class="text-caption text-grey-6 q-mt-xs">
                  This may take up to 60 minutes.
                </div>
              </div>

              <!-- Phase 5: Complete -->
              <div v-if="indexingKB && indexingStatus.phase === 'complete'" class="q-mt-md q-pa-md" style="background-color: #e8f5e9; border-radius: 4px; border: 1px solid #4caf50;">
                <div class="text-body2 text-positive">
                  ✅ {{ indexingStatus.message || 'Knowledge base indexed successfully!' }}
                </div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  <span v-if="indexingStatus.kb">KB: {{ indexingStatus.kb }} • </span>
                  Tokens: {{ indexingStatus.tokens }} • 
                  Files: {{ indexingStatus.filesIndexed }}
                </div>
              </div>

              <!-- Phase 6: Error -->
              <div v-if="indexingKB && indexingStatus.phase === 'error'" class="q-mt-md q-pa-md" style="background-color: #ffebee; border-radius: 4px; border: 1px solid #f44336;">
                <div class="text-body2 text-negative">
                  ❌ {{ indexingStatus.error || 'Indexing failed' }}
                </div>
                <div v-if="indexingStatus.kb" class="text-caption text-grey-7 q-mt-xs">KB: {{ indexingStatus.kb }}</div>
              </div>
            </div>
          </q-tab-panel>

          <!-- My AI Agent Tab -->
          <q-tab-panel name="agent">
            <div class="row items-center justify-between q-mb-md">
              <div class="text-h6">Agent Instructions</div>
              <q-btn
                label="EDIT"
                color="primary"
                @click="editMode = !editMode"
                :icon="editMode ? 'close' : 'edit'"
              />
            </div>

            <!-- Deep link Private AI access switch -->
            <div class="row items-center justify-center q-mb-md">
              <q-toggle
                v-model="allowDeepLinkPrivateAI"
                label="Deep link users can chat with your Private AI"
                color="primary"
                :loading="savingDeepLinkSetting"
                @update:model-value="saveDeepLinkPrivateAISetting"
              />
            </div>

            <div v-if="loadingAgent" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading agent...</div>
            </div>

            <div v-else-if="agentError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ agentError }}</div>
              <q-btn label="Retry" color="primary" @click="loadAgent" class="q-mt-md" />
            </div>

            <div v-else-if="agentInstructions">
              <div v-if="editMode" class="q-mb-md">
                <q-input
                  v-model="editedInstructions"
                  type="textarea"
                  rows="15"
                  outlined
                  autofocus
                />
                <div class="q-mt-md">
                  <q-btn label="Save" color="primary" @click="saveInstructions" :loading="savingInstructions" />
                  <q-btn label="Cancel" flat @click="cancelEdit" class="q-ml-sm" />
                </div>
              </div>

              <div v-else>
                <div class="q-mb-md">
                  <vue-markdown :source="agentInstructions" />
                </div>
              </div>

              <!-- Agent Knowledge Base Section -->
              <div v-if="kbInfo" class="q-mt-lg" style="border-top: 1px solid #e0e0e0; padding-top: 16px;">
                <div class="text-h6 q-mb-md">Agent Knowledge Base</div>
                
                <div class="row items-center q-mb-sm">
                  <div class="col">
                    <div class="text-weight-medium">{{ kbInfo.name }}</div>
                    <div class="text-caption text-grey-7 q-mt-xs">
                      Last indexed: {{ formatRelativeTime(kbInfo.lastIndexedAt) }}
                    </div>
                  </div>
                  <div class="col-auto">
                    <q-chip
                      :color="kbInfo.connected ? 'green' : 'amber'"
                      text-color="white"
                      :label="kbInfo.connected ? 'Connected' : 'Not Connected'"
                      clickable
                      @click="toggleKBConnection"
                      :disable="togglingKB"
                      :loading="togglingKB"
                    />
                  </div>
                </div>
                
                <div class="q-mt-md">
                  <div class="text-caption text-grey-7 q-mb-xs">Indexed Files:</div>
                  <div 
                    v-if="indexedFileNames.length === 0"
                    class="text-caption text-grey-5"
                  >
                    No files indexed yet
                  </div>
                  <q-list
                    v-else
                    dense
                    :class="{ 'text-grey-5': !kbInfo.connected }"
                  >
                    <q-item
                      v-for="(fileName, index) in indexedFileNames"
                      :key="index"
                      dense
                    >
                      <q-item-section>
                        <q-item-label 
                          :class="{ 'text-grey-5': !kbInfo.connected }"
                          class="text-caption"
                        >
                          {{ fileName }}
                        </q-item-label>
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
              </div>

              <div v-else-if="!loadingAgent" class="q-mt-lg text-center text-grey-7">
                <div class="text-caption">No knowledge base configured</div>
              </div>
            </div>

            <div v-else class="text-center q-pa-md text-grey">
              <q-icon name="smart_toy" size="3em" />
              <div class="q-mt-sm">No agent found</div>
            </div>
          </q-tab-panel>

          <!-- Saved Chats Tab -->
          <q-tab-panel name="chats">
            <div v-if="loadingChats" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading chats...</div>
            </div>

            <div v-else-if="chatsError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ chatsError }}</div>
              <q-btn label="Retry" color="primary" @click="loadSharedChats" class="q-mt-md" />
            </div>

            <div v-else-if="sharedChats.length === 0" class="text-center q-pa-md text-grey">
              <q-icon name="chat" size="3em" />
              <div class="q-mt-sm">No shared group chats found</div>
            </div>

            <div v-else class="q-mt-md">
              <q-list>
                <q-item
                  v-for="chat in sortedSharedChats"
                  :key="chat._id"
                  clickable
                  class="q-pa-md q-mb-sm"
                  style="border: 1px solid #e0e0e0; border-radius: 8px;"
                  @click="selectChat(chat)"
                >
                  <q-item-section>
                    <q-item-label class="text-weight-medium">
                      {{ formatDate(chat.updatedAt || chat.createdAt) }}
                    </q-item-label>
                    <q-item-label caption class="q-mt-xs">
                      {{ getLastQueryDescription(chat) }}
                    </q-item-label>
                    <q-item-label caption class="q-mt-xs">
                      Group Participants: {{ getGroupParticipants(chat) }}
                    </q-item-label>
                    <q-item-label v-if="chat.shareId" caption class="q-mt-xs text-primary">
                      <q-icon name="link" size="xs" />
                      Deep link: /chat/{{ chat.shareId }}
                    </q-item-label>
                  </q-item-section>
                  <q-item-section side @click.stop>
                    <div class="row items-center q-gutter-xs">
                      <q-btn
                        flat
                        round
                        dense
                        icon="link"
                        color="primary"
                        @click="copyChatLink(chat)"
                        title="Copy deep link"
                      />
                      <q-btn
                        flat
                        round
                        dense
                        icon="delete"
                        color="negative"
                        @click="confirmDeleteChat(chat)"
                        title="Delete chat"
                      />
                    </div>
                  </q-item-section>
                </q-item>
              </q-list>
            </div>
          </q-tab-panel>

          <!-- My Lists Tab -->
          <q-tab-panel name="lists">
            <Lists
              :userId="userId"
              @back-to-chat="closeDialog"
            />
          </q-tab-panel>

          <!-- Privacy Filter Tab -->
          <q-tab-panel name="privacy">
            <!-- Filter Current Chat Button -->
            <div class="q-pa-md" style="border-bottom: 1px solid #eee;">
              <q-btn
                label="Filter Current Chat"
                color="primary"
                icon="filter_alt"
                :disable="!privacyFilterMapping.length || !props.originalMessages || props.originalMessages.length === 0"
                @click="filterCurrentChat"
                class="full-width"
              />
              <div v-if="!privacyFilterMapping.length" class="text-caption text-grey q-mt-xs text-center">
                No pseudonym mapping available
              </div>
              <div v-else-if="!props.originalMessages || props.originalMessages.length === 0" class="text-caption text-grey q-mt-xs text-center">
                No chat messages available
              </div>
            </div>

            <div v-if="loadingPrivacyFilter" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Analyzing chat for names...</div>
            </div>

            <div v-else-if="privacyFilterError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ privacyFilterError }}</div>
              <q-btn label="Retry" color="primary" @click="loadPrivacyFilter" class="q-mt-md" />
            </div>

            <div v-else-if="privacyFilterMapping.length > 0" class="q-pa-md">
              <div class="text-h6 q-mb-md">Privacy Filter - Name Pseudonymization</div>
              
              <div v-if="loadingRandomNames" class="text-center q-pa-md">
                <q-spinner size="1.5em" />
                <div class="q-mt-sm">Generating pseudonyms...</div>
              </div>
              
              <div v-else class="q-mt-md">
                <div class="text-body2 text-grey q-mb-sm">
                  Showing {{ privacyFilterMapping.length }} name{{ privacyFilterMapping.length !== 1 ? 's' : '' }} in pseudonym mapping
                </div>
                <q-table
                  :rows="privacyFilterMapping"
                  :columns="[
                    { name: 'original', label: 'Original Name', field: 'original', align: 'left' },
                    { name: 'pseudonym', label: 'Pseudonym', field: 'pseudonym', align: 'left' }
                  ]"
                  row-key="original"
                  flat
                  bordered
                  :rows-per-page-options="[0]"
                  hide-pagination
                />
              </div>
            </div>

            <div v-else-if="privacyFilterResponse" class="q-pa-md">
              <div class="text-h6 q-mb-md">Privacy Filter - Name Pseudonymization</div>
              <div class="text-body2 text-grey q-mb-md">No pseudonym mapping available. Original response:</div>
              <div class="privacy-filter-response">
                <vue-markdown :source="privacyFilterResponse" />
              </div>
            </div>

            <div v-else class="text-center q-pa-md text-grey">
              <q-icon name="person_off" size="3em" />
              <div class="q-mt-sm">No mapping available</div>
            </div>
          </q-tab-panel>

          <!-- Patient Diary Tab -->
          <q-tab-panel name="diary" class="q-pa-none" style="display: flex; flex-direction: column; height: 100%;">
            <div v-if="loadingDiary" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading diary...</div>
            </div>

            <div v-else-if="diaryError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ diaryError }}</div>
              <q-btn label="Retry" color="primary" @click="loadDiary" class="q-mt-md" />
            </div>

            <div v-else style="display: flex; flex-direction: column; height: 100%;">
              <!-- Diary Messages Area -->
              <div 
                ref="diaryMessagesRef" 
                class="q-pa-md" 
                style="flex: 1; overflow-y: auto; min-height: 0;"
              >
                <div v-if="diaryEntries.length === 0" class="text-center q-pa-md text-grey">
                  <q-icon name="book" size="3em" />
                  <div class="q-mt-sm">No diary entries yet</div>
                  <div class="text-caption q-mt-xs">Start writing your first entry below</div>
                </div>

                <template v-for="bubble in diaryBubbles" :key="bubble.entries[bubble.entries.length - 1]?.id || bubble.lastDateTime">
                  <div class="q-mb-md" style="position: relative;">
                    <div class="row items-center justify-between q-mb-xs">
                      <div class="text-caption text-grey-7">
                        {{ formatDiaryDateTime(bubble.lastDateTime) }}
                      </div>
                      <div class="row q-gutter-xs">
                        <q-btn
                          flat
                          dense
                          size="sm"
                          icon="send"
                          color="primary"
                          label="Post diary to chat"
                          @click="postBubbleToChat(bubble)"
                        />
                        <q-btn
                          flat
                          dense
                          round
                          size="sm"
                          icon="delete"
                          color="negative"
                          @click="deleteBubble(bubble)"
                          title="Delete bubble"
                        />
                      </div>
                    </div>
                    <div 
                      class="q-pa-md bg-blue-1 rounded-borders"
                      style="display: inline-block; max-width: 80%;"
                      :class="{ 'opacity-60': bubble.closed }"
                    >
                      <div
                        v-for="(entry, entryIdx) in bubble.entries" 
                        :key="entry.id || entryIdx"
                        class="text-body1"
                        :class="{ 'q-mb-sm': entryIdx < bubble.entries.length - 1 }"
                        style="white-space: pre-wrap;"
                      >
                        <span class="text-grey-7 text-caption">{{ formatDiaryTime(entry.dateTime) }}</span> {{ entry.message }}
                      </div>
                    </div>
                  </div>
                </template>
              </div>

              <!-- Text Input Area -->
              <div class="q-pa-md" style="flex-shrink: 0; border-top: 1px solid #eee;">
                <q-input
                  v-model="diaryInputText"
                  type="textarea"
                  autogrow
                  filled
                  placeholder="Write your diary entry..."
                  :disable="isSavingDiary"
                  @keydown.enter.ctrl="addDiaryEntry"
                  @keydown.enter.meta="addDiaryEntry"
                  class="q-mb-sm"
                />
                <div class="row justify-end">
                  <q-btn
                    label="Add Entry"
                    color="primary"
                    icon="send"
                    @click="addDiaryEntry"
                    :loading="isSavingDiary"
                    :disable="!diaryInputText.trim() || isSavingDiary"
                  />
                </div>
              </div>
            </div>
          </q-tab-panel>

          <!-- SHARED REFERENCES Tab -->
          <q-tab-panel name="references" class="q-pa-none" style="display: flex; flex-direction: column; height: 100%;">
            <div v-if="loadingReferences" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading references...</div>
            </div>

            <div v-else-if="referencesError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ referencesError }}</div>
              <q-btn label="Retry" color="primary" @click="loadReferences" class="q-mt-md" />
            </div>

            <div v-else style="display: flex; flex-direction: column; height: 100%;">
              <!-- Header with paperclip -->
              <div class="q-pa-md" style="flex-shrink: 0; border-bottom: 1px solid #eee;">
                <div class="row items-center justify-between">
                  <div class="text-h6">Shared References</div>
                  <q-btn 
                    flat 
                    dense 
                    round 
                    icon="attach_file" 
                    class="text-grey-6" 
                    @click="triggerReferenceFileInput"
                    title="Upload reference file"
                  >
                    <q-tooltip>Upload a reference file</q-tooltip>
                  </q-btn>
                  <input
                    ref="referenceFileInput"
                    type="file"
                    style="display: none"
                    @change="handleReferenceFileSelect"
                    accept=".pdf,.txt,.md"
                  />
                </div>
              </div>

              <!-- References List -->
              <div class="q-pa-md" style="flex: 1; overflow-y: auto; min-height: 0;">
                <div v-if="referenceFiles.length === 0" class="text-center q-pa-md text-grey">
                  <q-icon name="link" size="3em" />
                  <div class="q-mt-sm">No reference files yet</div>
                  <div class="text-caption q-mt-xs">Use the paperclip icon to upload reference files</div>
                </div>

                <q-list v-else>
                  <q-item 
                    v-for="file in referenceFiles" 
                    :key="file.bucketKey" 
                    class="q-pa-md"
                    clickable
                    @click="showAddReferenceToChatDialog(file)"
                  >
                    <q-item-section avatar>
                      <q-icon name="description" size="2em" color="primary" />
                    </q-item-section>
                    <q-item-section>
                      <q-item-label>{{ file.fileName }}</q-item-label>
                      <q-item-label caption>
                        {{ formatFileSize(file.fileSize) }} • Uploaded {{ formatDate(file.uploadedAt) }}
                      </q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <div class="row items-center q-gutter-xs">
                        <q-btn 
                          flat 
                          dense 
                          round 
                          size="sm"
                          icon="visibility" 
                          color="primary"
                          @click.stop="viewReferenceFile(file)"
                          title="View file"
                        />
                        <q-btn 
                          flat 
                          dense 
                          round 
                          size="sm"
                          icon="delete" 
                          color="negative"
                          @click.stop="deleteReferenceFile(file)"
                          title="Delete file"
                        />
                      </div>
                    </q-item-section>
                  </q-item>
                </q-list>
              </div>
            </div>
          </q-tab-panel>

          <!-- Patient Summary Tab -->
          <q-tab-panel name="summary">
            <div v-if="loadingSummary" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading patient summary...</div>
            </div>

            <div v-else-if="summaryError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ summaryError }}</div>
              <q-btn label="Retry" color="primary" @click="loadPatientSummary" class="q-mt-md" />
            </div>

            <div v-else-if="patientSummary" class="q-mt-md">
              <div class="row items-center justify-between q-gutter-sm q-mb-sm">
                <div class="text-caption text-grey-7">
                  <!-- Patient summary editing -->
              </div>
                <div class="row q-gutter-sm">
                  <q-btn
                    v-if="!isEditingSummaryTab"
                    outline
                    label="Edit"
                    color="primary"
                    icon="edit"
                    @click="startSummaryEdit"
                  />
                  <q-btn
                    v-else
                    flat
                    label="Cancel"
                    color="grey-8"
                    icon="close"
                    @click="cancelSummaryEdit"
                    :disable="isSavingSummary"
                  />
                </div>
              </div>

              <div v-if="isEditingSummaryTab">
                <q-input
                  v-model="summaryEditText"
                  type="textarea"
                  autogrow
                  filled
                  class="bg-grey-1 rounded-borders"
                  :disable="isSavingSummary"
                  placeholder="Enter patient summary..."
                />
              </div>
              <div v-else class="text-body1 q-pa-md bg-grey-1 rounded-borders">
                <vue-markdown :source="patientSummary" />
              </div>

              <div class="row items-center q-gutter-sm q-mt-md">
                <q-btn
                  v-if="isEditingSummaryTab"
                  label="Save"
                  color="primary"
                  icon="save"
                  @click="saveSummaryFromTab"
                  :loading="isSavingSummary"
                  :disable="isSavingSummary"
                />
                <!-- Buttons for non-current summaries -->
                <template v-for="(summary, index) in patientSummaries" :key="index">
                  <q-btn
                    v-if="!summary.isCurrent && !isEditingSummaryTab"
                    outline
                    :label="`SUMMARY ${getTimeAgo(summary.updatedAt || summary.createdAt)} ago`"
                    color="grey-7"
                    size="sm"
                    @click="swapSummary(index)"
                    :disable="isSavingSummary"
                  />
                </template>
                <q-space />
                <q-btn 
                  label="Request New Summary" 
                  color="primary" 
                  @click="requestNewSummary"
                  icon="refresh"
                  :disable="isEditingSummaryTab || isSavingSummary"
                  :loading="loadingSummary"
                />
              </div>
            </div>

            <div v-else class="text-center q-pa-md text-grey">
              <q-icon name="description" size="3em" />
              <div class="q-mt-sm">No patient summary found</div>
              <div class="q-mt-md">
                <q-btn 
                  label="Request Summary" 
                  color="primary" 
                  @click="requestNewSummary"
                  icon="add"
                />
              </div>
            </div>
          </q-tab-panel>
        </q-tab-panels>
      </q-card-section>
    </q-card>
    
    <!-- PDF Viewer Modal -->
    <PdfViewerModal
      v-model="showPdfViewer"
      :file="viewingFile"
    />

    <!-- Text/Markdown Viewer Modal -->
    <TextViewerModal
      v-model="showTextViewer"
      :file="viewingFile"
    />

    <!-- Patient Summary Available Modal (used both before and after generation) -->
    <q-dialog v-model="showSummaryAvailableModal" persistent>
      <q-card style="min-width: 400px; max-width: 600px;">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">
            {{ isSummaryModalBeforeGeneration ? 'Replace Existing Summary?' : 'New Patient Summary Available' }}
          </div>
        </q-card-section>

        <q-card-section>
          <div class="text-body1">
            {{ isSummaryModalBeforeGeneration 
              ? 'A patient summary already exists. Generating a new summary will replace the current one. Do you want to continue?'
              : 'A new patient summary has been generated based on your updated knowledge base.' }}
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md">
          <q-btn 
            flat 
            :label="isSummaryModalBeforeGeneration 
              ? 'CANCEL' 
              : (patientSummary ? 'KEEP SAVED SUMMARY' : 'CLOSE MyStuff')" 
            color="grey-8" 
            @click="handleCloseSummaryModal"
          />
          <q-btn 
            flat 
            label="REPLACE SUMMARY" 
            color="primary" 
            @click="isSummaryModalBeforeGeneration ? handleConfirmReplaceSummary() : handleSaveSummary()"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Patient Summary View Modal -->
    <q-dialog v-model="showSummaryViewModal" persistent>
      <q-card style="min-width: 600px; max-width: 900px; max-height: 80vh;">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Patient Summary</div>
          <q-space />
          <q-btn icon="close" flat round dense @click="handleCloseWithoutSaving" />
        </q-card-section>

        <q-card-section style="max-height: 60vh; overflow-y: auto;">
          <div v-if="!editingSummary" class="text-body2">
            <vue-markdown :source="summaryViewText" />
          </div>
          <q-input
            v-else
            v-model="summaryViewText"
            type="textarea"
            autofocus
            rows="20"
            filled
            style="width: 100%;"
          />
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md">
          <q-btn 
            flat 
            label="CLOSE WITHOUT SAVING" 
            color="grey-8" 
            @click="handleCloseWithoutSaving"
          />
          <q-btn 
            v-if="editingSummary"
            label="SAVE" 
            color="primary" 
            @click="handleSaveEditedSummary"
          />
          <q-btn 
            v-else
            label="EDIT" 
            color="primary" 
            @click="handleEditSummary"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Replace Summary Dialog (when new summary is created and all slots are full) -->
    <q-dialog v-model="showReplaceSummaryDialog" persistent>
      <q-card style="min-width: 800px; max-width: 1200px; max-height: 90vh;">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">New Patient Summary Generated</div>
        </q-card-section>

        <q-card-section style="max-height: 60vh; overflow-y: auto;">
          <div class="text-body1 q-mb-md">
            A new patient summary has been generated. Choose which summary to replace:
          </div>
          <div class="text-body2 q-pa-md bg-grey-1 rounded-borders">
            <vue-markdown :source="newSummaryToReplace" />
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md">
          <!-- Buttons for each existing summary (oldest to newest) -->
          <template v-for="(summary, index) in patientSummaries" :key="index">
            <q-btn 
              flat 
              :label="`Replace ${getTimeAgo(summary.updatedAt || summary.createdAt)} ago summary`"
              color="primary" 
              @click="handleReplaceSummaryByIndex(index)"
            />
          </template>
          <q-btn 
            flat 
            label="Close without saving" 
            color="grey-8" 
            @click="showReplaceSummaryDialog = false; newSummaryToReplace = ''"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from 'vue';
import VueMarkdown from 'vue-markdown-render';
import PdfViewerModal from './PdfViewerModal.vue';
import TextViewerModal from './TextViewerModal.vue';
import Lists from './Lists.vue';
import { useQuasar } from 'quasar';
import { deleteChatById } from '../utils/chatApi';

interface UserFile {
  fileName: string;
  bucketKey: string;
  fileSize: number;
  uploadedAt: string;
  inKnowledgeBase: boolean;
  knowledgeBases?: string[];
  fileType?: string;
}

interface SavedChat {
  _id: string;
  type: string;
  shareId: string;
  currentUser: string;
  patientOwner?: string;
  chatHistory: any[];
  uploadedFiles: any[];
  createdAt: string;
  updatedAt: string;
  isShared?: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  name?: string;
  authorId?: string;
  authorLabel?: string;
  authorType?: 'user' | 'assistant';
  providerKey?: string;
}

interface Props {
  modelValue: boolean;
  userId: string;
  initialTab?: string;
  messages?: Message[];
  originalMessages?: Message[]; // Original unfiltered messages for privacy filtering
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'files',
  messages: () => [],
  originalMessages: () => []
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'chat-selected': [chat: SavedChat];
  'indexing-started': [data: { jobId: string; phase: string }];
  'indexing-status-update': [data: { jobId: string; phase: string; tokens: string; filesIndexed: number; progress: number }];
  'indexing-finished': [data: { jobId: string; phase: string; error?: string }];
  'files-archived': [archivedFiles: string[]]; // Emit bucketKeys of archived files
  'messages-filtered': [messages: Message[]]; // Emit filtered messages with pseudonyms
  'diary-posted': [content: string]; // Emit diary content to add to chat
  'reference-file-added': [file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string; isReference: boolean }]; // Emit reference file to add to chat
}>();

const isOpen = ref(props.modelValue);
const currentTab = ref(props.initialTab || 'files');
const loadingFiles = ref(false);
const filesError = ref('');
const userFiles = ref<UserFile[]>([]);
const updatingFiles = ref(new Set<string>());

const loadingAgent = ref(false);
const agentError = ref('');
const agentInstructions = ref('');
const editMode = ref(false);
const editedInstructions = ref('');
const savingInstructions = ref(false);

// Deep link Private AI access setting
const allowDeepLinkPrivateAI = ref(true); // Default to enabled
const savingDeepLinkSetting = ref(false);

// KB info for agent tab
const kbInfo = ref<{
  name: string;
  kbId: string;
  connected: boolean;
  indexedFiles: string[];
  lastIndexedAt: string | null;
} | null>(null);
const togglingKB = ref(false);

const loadingChats = ref(false);
const chatsError = ref('');
const sharedChats = ref<SavedChat[]>([]);

// Patient Summary
const loadingSummary = ref(false);
const summaryError = ref('');

// Privacy Filter
const loadingPrivacyFilter = ref(false);
const privacyFilterError = ref('');
const privacyFilterResponse = ref('');
const privacyFilterMapping = ref<Array<{ original: string; pseudonym: string }>>([]);
const loadingRandomNames = ref(false);
const patientSummary = ref('');
const patientSummaries = ref<Array<{ text: string; createdAt: string; updatedAt: string; isCurrent: boolean }>>([]);

// Patient Diary
const loadingDiary = ref(false);
const diaryError = ref('');
const diaryEntries = ref<Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>>([]);
const diaryInputText = ref('');
const isSavingDiary = ref(false);
const diaryMessagesRef = ref<HTMLElement | null>(null);

// Shared References
const loadingReferences = ref(false);
const referencesError = ref('');
const referenceFiles = ref<Array<{ fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }>>([]);
const referenceFileInput = ref<HTMLInputElement | null>(null);
const isUploadingReference = ref(false);
const selectedReferenceForChat = ref<{ fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string } | null>(null);
const savedCurrentSummaryForUndo = ref<{ text: string; createdAt: string; updatedAt: string } | null>(null);
const showReplaceSummaryDialog = ref(false);
const newSummaryToReplace = ref('');

// PDF Viewer
const showPdfViewer = ref(false);
const showTextViewer = ref(false);
const viewingFile = ref<any>(null);

// KB management
const originalFiles = ref<UserFile[]>([]);
const originalIndexedFiles = ref<string[]>([]); // Track original indexed files state
const indexedFiles = ref<string[]>([]); // Track which files are actually indexed
const kbNeedsUpdate = ref(false); // Track if KB needs to be updated (files moved)

const hasCheckboxChanges = computed(() => {
  if (originalFiles.value.length !== userFiles.value.length) return true;
  return userFiles.value.some((file, index) => {
    const original = originalFiles.value[index];
    return !original || file.inKnowledgeBase !== original.inKnowledgeBase;
  });
});

// Mark KB as dirty when files are moved
watch(hasCheckboxChanges, (hasChanges) => {
  if (hasChanges && !indexingKB.value) {
    kbNeedsUpdate.value = true;
  }
});
// Check if KB folder contents match indexed files
const kbIndexingOutOfSync = computed(() => {
  // Get all files currently in KB folder (inKnowledgeBase = true)
  const currentKBFiles = userFiles.value
    .filter(file => file.inKnowledgeBase)
    .map(file => file.bucketKey);
  
  // Sort both arrays for comparison
  const currentSorted = [...currentKBFiles].sort();
  const indexedSorted = [...indexedFiles.value].sort();
  
  // Compare arrays
  if (currentSorted.length !== indexedSorted.length) return true;
  return currentSorted.some((key, index) => key !== indexedSorted[index]);
});

// Computed property that returns a function to check if a file is indexed (ensures reactivity)
const isFileIndexed = computed(() => {
  // Create a Set for O(1) lookup
  const indexedSet = new Set(indexedFiles.value);
  // Return a function that checks if a bucketKey is in the set
  return (bucketKey: string): boolean => {
    return indexedSet.has(bucketKey);
  };
});
const indexingKB = ref(false);
const resettingKB = ref(false);
const indexingStatus = ref({
  phase: 'moving', // 'moving' | 'kb_setup' | 'indexing_started' | 'indexing' | 'complete' | 'error'
  message: '',
  kb: '',
  tokens: '',
  filesIndexed: 0,
  progress: 0,
  error: ''
});

// Check if we're in development/localhost (show RESET KB button only in dev)
const isDevelopment = computed(() => {
  if (typeof window === 'undefined') return false;
  return import.meta.env.DEV || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
});
const currentIndexingJobId = ref<string | null>(null);
const pollingInterval = ref<ReturnType<typeof setInterval> | null>(null);
const elapsedTimeInterval = ref<ReturnType<typeof setInterval> | null>(null);
const indexingStartTime = ref<number | null>(null);
const INDEXING_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const elapsedTimeUpdate = ref(0); // Force updates for elapsed time display

// Computed property for elapsed time display
const indexingElapsedTime = computed(() => {
  if (!indexingStartTime.value) return null;
  // Use elapsedTimeUpdate to force reactivity
  void elapsedTimeUpdate.value; // Force reactivity by reading the value
  const elapsed = Date.now() - indexingStartTime.value;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
});

// Patient summary modal state
const showSummaryAvailableModal = ref(false);
const showSummaryViewModal = ref(false);
const isSummaryModalBeforeGeneration = ref(false); // true = before generation, false = after generation
const pendingSummaryGeneration = ref<(() => Promise<void>) | null>(null);
const newPatientSummary = ref('');
const editingSummary = ref(false);
const summaryViewText = ref('');
const isEditingSummaryTab = ref(false);
const summaryEditText = ref('');
const isSavingSummary = ref(false);

watch(patientSummary, (newValue) => {
  if (!isEditingSummaryTab.value) {
    summaryEditText.value = newValue || '';
  }
});

const hasUnsavedAgentChanges = computed(() => {
  if (!editMode.value) return false;
  const current = (editedInstructions.value || '').trim();
  const original = (agentInstructions.value || '').trim();
  return current !== original;
});

const hasUnsavedSummaryChanges = computed(() => {
  if (!isEditingSummaryTab.value) return false;
  const current = (summaryEditText.value || '').trim();
  const original = (patientSummary.value || '').trim();
  return current !== original;
});

const hasUnsavedChanges = computed(() => hasUnsavedAgentChanges.value || hasUnsavedSummaryChanges.value);

const $q = useQuasar();

const loadFiles = async () => {
  loadingFiles.value = true;
  filesError.value = '';

  try {
    // First, auto-archive any files at root level (userId/)
    // This ensures files imported via paper clip are moved to archived when opening SAVED FILES tab
    try {
      const archiveResponse = await fetch('/api/archive-user-files', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          userId: props.userId
        })
      });
      
      if (archiveResponse.ok) {
        const archiveResult = await archiveResponse.json();
        // Emit event with archived file bucketKeys so chat interface can clear badges
        // The archive endpoint returns archivedFiles array with filenames
        // Original bucketKeys would have been userId/filename before archiving
        if (archiveResult.archivedFiles && Array.isArray(archiveResult.archivedFiles) && archiveResult.archivedFiles.length > 0) {
          const originalRootKeys = archiveResult.archivedFiles.map((fileName: string) => `${props.userId}/${fileName}`);
          emit('files-archived', originalRootKeys);
        }
      }
      // Don't fail if archiving fails - just continue to load files
    } catch (archiveErr) {
      console.warn('Failed to auto-archive files:', archiveErr);
    }

    // Then load files as normal - request verification when loading SAVED FILES tab
    const response = await fetch(`/api/user-files?userId=${encodeURIComponent(props.userId)}&verify=true`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch files: ${response.statusText}`);
    }
    const result = await response.json();
    
    // Determine KB folder pattern: userId/kbName/ (kbName contains -kb-)
    // Files in KB folder have bucketKey matching: userId/kbName/filename
    // Files NOT in KB folder are: userId/filename (root) or userId/archived/filename
    userFiles.value = (result.files || []).map((file: any) => {
      const bucketKey = file.bucketKey || '';
      const parts = bucketKey.split('/');
      // File is in KB folder if:
      // 1. Has at least 3 parts (userId/kbName/filename)
      // 2. Second part (kbName) contains '-kb-'
      // 3. Not in archived folder
      const isInKB = parts.length >= 3 && 
                     parts[0] === props.userId && 
                     parts[1]?.includes('-kb-') && 
                     parts[1] !== 'archived';
      
      return {
        ...file,
        inKnowledgeBase: isInKB
      };
    });
    originalFiles.value = JSON.parse(JSON.stringify(userFiles.value));
    
    // Load indexed files from user document (single source of truth)
    // Do NOT derive from userFiles - that creates a mismatch with server state
    if (result.indexedFiles && Array.isArray(result.indexedFiles)) {
      indexedFiles.value = result.indexedFiles;
      originalIndexedFiles.value = [...result.indexedFiles]; // Save original state
    } else {
      // If server doesn't provide indexedFiles, initialize as empty array
      // This indicates files haven't been indexed yet, not that they should match userFiles
      indexedFiles.value = [];
      originalIndexedFiles.value = [];
    }
    
    // Reset dirty flag when files are loaded (dialog opened or refreshed)
    kbNeedsUpdate.value = false;
    
    // Display verification result in browser console if available
    if (result.verificationResult) {
      const vr = result.verificationResult;
      console.log('[KB VERIFY] Verification Result:', {
        inconsistencies: vr.inconsistencies || 'None',
        cleanupActions: vr.cleanupActions || 'None',
        userDocUpdates: vr.userDocUpdates || 'None',
        indexingInProgress: vr.indexingInProgress ? `Yes (jobId: ${vr.indexingJobId})` : 'No',
        needsIndexing: vr.needsIndexing ? 'Yes' : 'No',
        verifiedFiles: vr.verifiedFiles,
        indexedFiles: vr.indexedFiles,
        filesInS3: vr.filesInS3,
        filesWithoutDataSources: vr.filesWithoutDataSources
      });
      
      // If indexing is in progress, start polling
      if (vr.indexingInProgress && vr.indexingJobId) {
        console.log('[KB VERIFY] Indexing detected in progress, starting polling...');
        currentIndexingJobId.value = vr.indexingJobId;
        indexingKB.value = true;
        indexingStartTime.value = Date.now();
        indexingStatus.value = {
          phase: 'indexing',
          message: 'Indexing in progress...',
          kb: '',
          tokens: '0',
          filesIndexed: 0,
          progress: 0,
          error: ''
        };
        pollIndexingProgress(vr.indexingJobId);
      } else if (vr.needsIndexing && !vr.indexingInProgress) {
        // Indexing is needed but not started - mark KB as needing update
        kbNeedsUpdate.value = true;
      }
    }
  } catch (err) {
    filesError.value = err instanceof Error ? err.message : 'Failed to load files';
  } finally {
    loadingFiles.value = false;
  }
};

// const _toggleKnowledgeBase = async (file: UserFile) => {
//   updatingFiles.value.add(file.bucketKey);
//
//   try {
//     const response = await fetch('/api/toggle-file-knowledge-base', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json'
//       },
//       credentials: 'include',
//       body: JSON.stringify({
//         userId: props.userId,
//         bucketKey: file.bucketKey,
//         inKnowledgeBase: file.inKnowledgeBase
//       })
//     });
//
//     if (!response.ok) {
//       throw new Error('Failed to update knowledge base status');
//     }
//
//     // Reload files to get updated state
//     await loadFiles();
//   } catch (err) {
//     filesError.value = err instanceof Error ? err.message : 'Failed to update knowledge base status';
//     // Revert checkbox on error
//     file.inKnowledgeBase = !file.inKnowledgeBase;
//   } finally {
//     updatingFiles.value.delete(file.bucketKey);
//   }
// };

const loadAgent = async () => {
  loadingAgent.value = true;
  agentError.value = '';

  try {
    const response = await fetch(`/api/agent-instructions?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch agent: ${response.statusText}`);
    }
    const result = await response.json();
    agentInstructions.value = result.instructions || '';
    editedInstructions.value = result.instructions || '';
    kbInfo.value = result.kbInfo || null;
    
    // Load deep link Private AI access setting
    await loadDeepLinkPrivateAISetting();
  } catch (err) {
    agentError.value = err instanceof Error ? err.message : 'Failed to load agent';
  } finally {
    loadingAgent.value = false;
  }
};

const loadDeepLinkPrivateAISetting = async () => {
  try {
    const response = await fetch(`/api/user-settings?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (response.ok) {
      const result = await response.json();
      // Default to true if not set (backward compatibility)
      allowDeepLinkPrivateAI.value = result.allowDeepLinkPrivateAI !== undefined ? result.allowDeepLinkPrivateAI : true;
    }
  } catch (err) {
    // If endpoint doesn't exist yet or fails, default to true
    console.warn('Failed to load deep link setting, defaulting to enabled:', err);
    allowDeepLinkPrivateAI.value = true;
  }
};

const saveDeepLinkPrivateAISetting = async () => {
  savingDeepLinkSetting.value = true;
  try {
    const response = await fetch('/api/user-settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        allowDeepLinkPrivateAI: allowDeepLinkPrivateAI.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save setting');
    }

    // Show notification
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: allowDeepLinkPrivateAI.value 
          ? 'Deep link users can now access your Private AI' 
          : 'Deep link users can no longer access your Private AI',
        timeout: 3000
      });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to save setting';
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: errorMsg,
        timeout: 3000
      });
    }
    // Revert on error
    allowDeepLinkPrivateAI.value = !allowDeepLinkPrivateAI.value;
  } finally {
    savingDeepLinkSetting.value = false;
  }
};

const saveInstructions = async () => {
  savingInstructions.value = true;

  try {
    const response = await fetch('/api/agent-instructions', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        instructions: editedInstructions.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save instructions');
    }

    agentInstructions.value = editedInstructions.value;
    editMode.value = false;
  } catch (err) {
    agentError.value = err instanceof Error ? err.message : 'Failed to save instructions';
  } finally {
    savingInstructions.value = false;
  }
};

const cancelEdit = () => {
  editedInstructions.value = agentInstructions.value;
  editMode.value = false;
};

// Format relative time (minutes, hours, days ago)
const formatRelativeTime = (dateString: string | null): string => {
  if (!dateString) return 'Never';
  
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
};

// Toggle KB connection
const toggleKBConnection = async () => {
  if (!kbInfo.value || togglingKB.value) return;
  
  togglingKB.value = true;
  
  // Store the current state for rollback on error
  const wasConnected = kbInfo.value.connected;
  
  try {
    const action = wasConnected ? 'detach' : 'attach';
    const response = await fetch('/api/toggle-kb-connection', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        action: action
      })
    });

    if (!response.ok) {
      throw new Error('Failed to toggle KB connection');
    }

    const result = await response.json();
    
    // Use the response directly - it's the source of truth from the backend
    // No need to call loadAgent() which goes through a cache
    if (kbInfo.value && typeof result.connected === 'boolean') {
      kbInfo.value.connected = result.connected;
    }
    
    // Show notification
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: result.message || `KB ${action === 'attach' ? 'attached' : 'detached'} successfully`,
        timeout: 3000
      });
    }
  } catch (err) {
    // Revert on error
    if (kbInfo.value) {
      kbInfo.value.connected = wasConnected;
    }
    const errorMsg = err instanceof Error ? err.message : 'Failed to toggle KB connection';
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: errorMsg,
        timeout: 5000
      });
    }
  } finally {
    togglingKB.value = false;
  }
};

// Get file names from indexed files (extract from bucketKey) - computed property for performance
const indexedFileNames = computed((): string[] => {
  if (!kbInfo.value || !kbInfo.value.indexedFiles) {
    return [];
  }
  
  return kbInfo.value.indexedFiles.map(bucketKey => {
    // Extract filename from bucketKey (format: userId/kbName/filename or userId/archived/filename)
    const parts = bucketKey.split('/');
    return parts[parts.length - 1] || bucketKey;
  });
});

const loadSharedChats = async () => {
  loadingChats.value = true;
  chatsError.value = '';

  try {
    const response = await fetch(`/api/shared-group-chats?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch chats: ${response.statusText}`);
    }
    const result = await response.json();
    sharedChats.value = result.chats || [];
  } catch (err) {
    chatsError.value = err instanceof Error ? err.message : 'Failed to load chats';
  } finally {
    loadingChats.value = false;
  }
};

const getLastQueryDescription = (chat: SavedChat): string => {
  if (!chat.chatHistory || chat.chatHistory.length === 0) {
    return 'No messages';
  }

  // Find the last user message
  for (let i = chat.chatHistory.length - 1; i >= 0; i--) {
    if (chat.chatHistory[i].role === 'user' && chat.chatHistory[i].content) {
      const content = chat.chatHistory[i].content;
      // Return first 100 characters
      return content.length > 100 ? content.substring(0, 100) + '...' : content;
    }
  }

  return 'No user query found';
};

const getGroupParticipants = (chat: SavedChat): string => {
  if (!chat.isShared || !chat.currentUser) {
    return 'None';
  }

  // For now, just return the current user
  // TODO: Extract all participants from chat history
  return chat.currentUser;
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatFileSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

// File management methods
const onCheckboxChange = async (file: UserFile) => {
  // Immediately move file when checkbox is toggled
  const oldBucketKey = file.bucketKey;
  const newStatus = file.inKnowledgeBase;
  
  // Add to updating set to show spinner
  updatingFiles.value.add(oldBucketKey);

  try {
    const response = await fetch('/api/toggle-file-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        bucketKey: oldBucketKey,
        inKnowledgeBase: newStatus
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || 'Failed to update knowledge base status');
    }

    const result = await response.json();
    
    // Reload files list to verify the move completed and matches the display
    await loadFiles();
    
    // Verify the file was moved correctly by checking the new file list
    const updatedFile = userFiles.value.find(f => 
      f.bucketKey === result.newBucketKey || 
      (result.newBucketKey && f.bucketKey === oldBucketKey && f.fileName === file.fileName)
    );
    
    if (updatedFile) {
      // Show success notification
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'positive',
          message: `File ${newStatus ? 'added to' : 'removed from'} knowledge base`,
          timeout: 2000
        });
      }
    }
    
    // Mark KB as dirty since a file was moved in/out of KB
    // loadFiles() resets kbNeedsUpdate, but we need to restore it after a file change
    if (!indexingKB.value) {
      kbNeedsUpdate.value = true;
    }
    
  } catch (err) {
    console.error(`Error toggling file ${file.fileName}:`, err);
    // Revert checkbox on error
    file.inKnowledgeBase = !newStatus;
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to update knowledge base status',
        timeout: 5000
      });
    }
  } finally {
    // Remove from updating set - use both old and new bucketKey in case it changed
    updatingFiles.value.delete(oldBucketKey);
    // Also try to remove any potential new bucketKey if the operation partially completed
    if (file.bucketKey && file.bucketKey !== oldBucketKey) {
      updatingFiles.value.delete(file.bucketKey);
    }
  }
};

// Helper to detect file type from stored file metadata
const detectFileTypeFromMetadata = (fileName: string, fileType?: string): 'text' | 'pdf' | 'markdown' => {
  // If fileType is already set and valid, use it
  if (fileType === 'pdf' || fileType === 'text' || fileType === 'markdown') {
    return fileType;
  }
  
  // Otherwise, detect from filename
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }
  if (ext === 'txt' || ext === 'text') {
    return 'text';
  }
  
  // Default to text for unknown types (safer than assuming PDF)
  return 'text';
};

const viewFileInPdfViewer = (file: UserFile) => {
  viewingFile.value = {
    bucketKey: file.bucketKey,
    name: file.fileName,
    type: detectFileTypeFromMetadata(file.fileName, file.fileType)
  };
  
  // Determine file type and open appropriate viewer
  const fileType = detectFileTypeFromMetadata(file.fileName, file.fileType);
  if (fileType === 'pdf') {
    showPdfViewer.value = true;
    showTextViewer.value = false;
  } else {
    // Default to text viewer for text, markdown, and unknown types
    showTextViewer.value = true;
    showPdfViewer.value = false;
  }
};

const confirmDeleteFile = (file: UserFile) => {
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Delete File',
      message: 'This will delete the file from MAIA, remove it from the knowledge base, and re-index. Make sure you have copies of your valuable files on your computer.',
      cancel: true,
      persistent: true
    }).onOk(() => {
      deleteFile(file);
    });
  } else if (window.confirm('This will delete the file from MAIA, remove it from the knowledge base, and re-index. Make sure you have copies of your valuable files on your computer. Are you sure you want to delete this file?')) {
    deleteFile(file);
  }
};

const deleteFile = async (file: UserFile) => {
  // Add file to updating set to show loading state
  updatingFiles.value.add(file.bucketKey);
  
  try {
    const response = await fetch(`/api/delete-file`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        bucketKey: file.bucketKey
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || 'Failed to delete file');
    }

    // Reload files to refresh the list
    await loadFiles();
    
    // If file was in KB, mark KB as needing update
    if (file.inKnowledgeBase) {
      kbNeedsUpdate.value = true;
    }
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'File deleted successfully',
        timeout: 3000
      });
    }
  } catch (err) {
    console.error('Error deleting file:', err);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to delete file',
        timeout: 5000
      });
    }
  } finally {
    updatingFiles.value.delete(file.bucketKey);
  }
};

const updateAndIndexKB = async () => {
  console.log('[KB] Update and Index KB button clicked');
  indexingKB.value = true;
  indexingStatus.value = {
    phase: 'moving',
    message: 'Moving files to knowledge base folder...',
    kb: '',
    tokens: '',
    filesIndexed: 0,
    progress: 0,
    error: ''
  };

  try {
    console.log('[KB] kbIndexingOutOfSync:', kbIndexingOutOfSync.value);
    console.log('[KB] hasCheckboxChanges:', hasCheckboxChanges.value);
    
    // Files are already moved by checkboxes - no need to send changes array
    // Phase 1: KB Setup (no longer moving files)
    indexingStatus.value.phase = 'kb_setup';
    indexingStatus.value.message = 'Setting up knowledge base...';

    console.log('[KB] Calling /api/update-knowledge-base with userId:', props.userId);

    const response = await fetch('/api/update-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });

    console.log('[KB] Response status:', response.status, response.statusText);

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = { message: `HTTP ${response.status}: ${response.statusText}` };
      }
      console.error('[KB] Error response:', errorData);
      throw new Error(errorData.message || `Failed to update knowledge base: ${response.status}`);
    }

    const result = await response.json();
    console.log('[KB] Response result:', result);
    
    // Update original files
    originalFiles.value = JSON.parse(JSON.stringify(userFiles.value));
    
    // Clear dirty flag since we're now indexing
    kbNeedsUpdate.value = false;
    
    // If jobId is returned, start polling
    if (result.jobId) {
      currentIndexingJobId.value = result.jobId;
      // Update phase based on response
      indexingStatus.value.phase = result.phase || 'indexing_started';
      indexingStatus.value.message = result.phase === 'indexing_started' 
        ? 'Indexing job started... This may take several minutes'
        : 'Setting up knowledge base...';
      indexingStatus.value.kb = result.kbId || result.kb || '';
      
      console.log('[KB] Starting to poll for job:', result.jobId);
      
      // Start polling for status
      pollIndexingProgress(result.jobId);
    } else if (result.error === 'INDEXING_ALREADY_RUNNING') {
      // KB already has an indexing job running - check if we can get the job ID
      console.log('[KB] Indexing already running:', result.message);
      if (result.kbId) {
        // Try to get the existing job ID from user document
        // For now, show a message and suggest waiting
        indexingKB.value = false;
        indexingStatus.value.phase = 'error';
        indexingStatus.value.error = result.message || 'Indexing job already running';
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'warning',
            message: 'Indexing already in progress. Please wait for it to complete.',
            timeout: 5000
          });
        } else {
          alert('Indexing already in progress. Please wait for it to complete.');
        }
      } else {
        throw new Error(result.message || 'Indexing job already running');
      }
    } else if (result.kbId && result.success) {
      // KB was created but jobId is null - indexing should start automatically
      // Poll for the job ID to appear
      console.log('[KB] KB created but no jobId yet. Polling for indexing job to appear...');
      indexingKB.value = true;
      indexingStatus.value.phase = 'indexing_started';
      indexingStatus.value.message = 'Knowledge base created. Waiting for indexing to start...';
      indexingStatus.value.kb = result.kbId;
      
      // Poll for job ID (up to 10 attempts with 3 second delays = 30 seconds max)
      let foundJobId = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        try {
          // Check user status to see if job ID is available
          const statusResponse = await fetch(`/api/user-status?userId=${props.userId}`, {
            method: 'GET',
            credentials: 'include'
          });
          
          if (statusResponse.ok) {
            const statusData = await statusResponse.json();
            if (statusData.kbLastIndexingJobId) {
              foundJobId = statusData.kbLastIndexingJobId;
              console.log(`[KB] Found job ID after polling: ${foundJobId} (attempt ${attempt + 1})`);
              break;
            }
          }
        } catch (pollError) {
          console.log(`[KB] Polling attempt ${attempt + 1} failed:`, pollError);
        }
      }
      
      if (foundJobId) {
        // Found job ID - start polling for progress
        currentIndexingJobId.value = foundJobId;
        console.log('[KB] Starting to poll for job:', foundJobId);
        pollIndexingProgress(foundJobId);
      } else {
        // Still no job ID after polling - show message but don't error
        console.log('[KB] Could not find job ID after polling. Indexing should start automatically.');
        indexingKB.value = false;
        indexingStatus.value.phase = 'complete';
        indexingStatus.value.message = 'Knowledge base created. Indexing will start automatically - please check back in a moment.';
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'info',
            message: 'Knowledge base created. Indexing will start automatically - please check back in a moment.',
            timeout: 5000
          });
        }
        // Reload files to show updated state
        await loadFiles();
        await loadAgent();
      }
    } else {
      // No job ID and no KB ID - something went wrong
      console.error('[KB] No jobId or kbId in response:', result);
      indexingKB.value = false;
      throw new Error('No indexing job ID returned from server');
    }
  } catch (err) {
    console.error('[KB] Error in updateAndIndexKB:', err);
    indexingKB.value = false;
    indexingStatus.value.phase = 'error';
    indexingStatus.value.error = err instanceof Error ? err.message : 'Failed to update knowledge base';
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'negative',
        message: indexingStatus.value.error,
        timeout: 5000
    });
    } else {
      // Fallback if Quasar notify is not available
      console.error('Notification error:', indexingStatus.value.error);
      alert(`Error: ${indexingStatus.value.error}`);
    }
  }
};

const resetKB = async () => {
  if (!confirm('Are you sure you want to reset the knowledge base? This will clear all KB-related data (KB ID, indexing status, indexed files) but keep the KB name and files unchanged.')) {
    return;
  }

  resettingKB.value = true;
  try {
    const response = await fetch('/api/reset-kb', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to reset KB');
    }

    const result = await response.json();
    console.log('[KB] KB reset:', result);

    // Reload files and agent info to reflect reset state
    await loadFiles();
    await loadAgent();

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Knowledge base reset successfully'
      });
    }
  } catch (err) {
    console.error('[KB] Error resetting KB:', err);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to reset KB'
      });
    } else {
      alert(`Error: ${err instanceof Error ? err.message : 'Failed to reset KB'}`);
    }
  } finally {
    resettingKB.value = false;
  }
};

const cancelIndexingAndRestore = async () => {
  if (!currentIndexingJobId.value) {
    console.warn('[KB Cancel] No active indexing job to cancel');
    return;
  }

  const jobId = currentIndexingJobId.value;
  console.log(`[KB Cancel] Cancelling indexing job ${jobId} and restoring files...`);

  try {
    // Stop polling
    if (pollingInterval.value) {
      clearInterval(pollingInterval.value);
      pollingInterval.value = null;
    }

    // Call cancel endpoint
    const response = await fetch('/api/cancel-kb-indexing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        jobId: jobId
      })
    });

    const result = await response.json();
    console.log('[KB Cancel] Cancel result:', result);

    // Check if indexing already completed
    if (result.alreadyCompleted || result.error === 'ALREADY_COMPLETED') {
      // Indexing already completed - just clear frontend state
      console.log('[KB Cancel] Indexing already completed - clearing frontend state');
      
      // Reset indexing state
      indexingKB.value = false;
      currentIndexingJobId.value = null;
      if (elapsedTimeInterval.value) {
        clearInterval(elapsedTimeInterval.value);
        elapsedTimeInterval.value = null;
      }
      indexingStartTime.value = null;
      elapsedTimeUpdate.value = 0;
      indexingStatus.value = {
        phase: 'complete',
        message: 'Indexing already completed',
        kb: '',
        tokens: '',
        filesIndexed: 0,
        progress: 1.0,
        error: ''
      };
      
      // Reload files to get current state
      await loadFiles();
      
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'info',
          message: 'Indexing has already completed',
          timeout: 3000
        });
      }
      return;
    }

    if (!response.ok) {
      throw new Error(result.message || 'Failed to cancel indexing');
    }

    // Reset indexing state
    indexingKB.value = false;
    currentIndexingJobId.value = null;
    if (elapsedTimeInterval.value) {
      clearInterval(elapsedTimeInterval.value);
      elapsedTimeInterval.value = null;
    }
    indexingStartTime.value = null;
    elapsedTimeUpdate.value = 0;
    indexingStatus.value = {
      phase: 'moving',
      message: '',
      kb: '',
      tokens: '',
      filesIndexed: 0,
      progress: 0,
      error: ''
    };

    // Reload files to get restored state (this updates bucketKeys)
    await loadFiles();
    
    // Force a small delay to ensure file list is fully updated before any PDF access
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Emit event to refresh any open PDF viewers with updated bucketKeys
    emit('files-archived', []); // Empty array signals a refresh without specific files

    // Show notification
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Indexing cancelled and files restored to original state',
        timeout: 3000
      });
    }
  } catch (err) {
    console.error('[KB Cancel] ❌ Error cancelling indexing:', err);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to cancel indexing',
        timeout: 5000
      });
    }
  }
};

const pollIndexingProgress = async (jobId: string) => {
  // Clear any existing polling interval
  if (pollingInterval.value) {
    clearInterval(pollingInterval.value);
  }
  
  // Set start time for timeout tracking
  indexingStartTime.value = Date.now();
  elapsedTimeUpdate.value = 0;
  
  // Start interval to update elapsed time display every second
  if (elapsedTimeInterval.value) {
    clearInterval(elapsedTimeInterval.value);
  }
  elapsedTimeInterval.value = setInterval(() => {
    if (indexingStartTime.value) {
      elapsedTimeUpdate.value = Date.now();
    } else {
      if (elapsedTimeInterval.value) {
        clearInterval(elapsedTimeInterval.value);
        elapsedTimeInterval.value = null;
      }
    }
  }, 1000);
  
  // Emit event to parent to update status tip
  emit('indexing-started', { jobId, phase: 'indexing_started' });
  
  // Poll every 10 seconds for indexing status
  const POLL_INTERVAL_MS = 10000; // 10 seconds
  pollingInterval.value = setInterval(async () => {
    try {
      // Check for timeout
      const elapsed = indexingStartTime.value ? (Date.now() - indexingStartTime.value) : 0;
      if (indexingStartTime.value && elapsed > INDEXING_TIMEOUT_MS) {
        clearInterval(pollingInterval.value!);
        pollingInterval.value = null;
        if (elapsedTimeInterval.value) {
          clearInterval(elapsedTimeInterval.value);
          elapsedTimeInterval.value = null;
        }
        indexingStartTime.value = null;
        elapsedTimeUpdate.value = 0;
        indexingKB.value = false;
        indexingStatus.value.phase = 'error';
        indexingStatus.value.error = 'Indexing timed out after 60 minutes';
        emit('indexing-finished', { jobId, phase: 'error', error: 'Indexing timed out' });
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'negative',
            message: 'Indexing timed out after 60 minutes. Please check the knowledge base status.'
          });
        }
        return;
      }
      
      const response = await fetch(`/api/kb-indexing-status/${jobId}?userId=${encodeURIComponent(props.userId)}`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error(`Failed to get indexing status: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      // Status check for job (verbose logging removed)
      
      // Update status with all fields from response
      indexingStatus.value = {
        phase: result.phase || indexingStatus.value.phase,
        message: result.message || indexingStatus.value.message,
        kb: result.kb || indexingStatus.value.kb,
        tokens: result.tokens || indexingStatus.value.tokens || '0',
        filesIndexed: result.filesIndexed || 0,
        progress: result.progress || 0,
        error: result.error || ''
      };
      
      // Emit status update to parent for status tip
      emit('indexing-status-update', {
        jobId,
        phase: indexingStatus.value.phase,
        tokens: indexingStatus.value.tokens,
        filesIndexed: indexingStatus.value.filesIndexed,
        progress: indexingStatus.value.progress
      });

      // Handle completion - check result.backendCompleted (backend has finished all automation),
      // result.completed, result.phase, or result.status
      // backendCompleted is the most reliable indicator that everything is done
      // Log completion detection for debugging
      const isCompleted = result.backendCompleted || result.completed || result.phase === 'complete' || result.status === 'INDEX_JOB_STATUS_COMPLETED';
      
      if (isCompleted) {
        console.log('[KB] ✅ Detected indexing completion:', {
          backendCompleted: result.backendCompleted,
          completed: result.completed,
          phase: result.phase,
          status: result.status,
          filesIndexed: result.filesIndexed,
          tokens: result.tokens
        });
        if (pollingInterval.value !== null) {
          clearInterval(pollingInterval.value);
        }
        pollingInterval.value = null;
        // Note: Keep indexingStartTime and elapsedTimeUpdate for final display
        
        // Refresh dialog for any completion status (not just backendCompleted or phase='complete')
        // This ensures the UI updates when status='INDEX_JOB_STATUS_COMPLETED' even if phase is still 'indexing'
        indexingStatus.value.phase = 'complete';
        indexingStatus.value.message = 'Knowledge base indexed successfully!';
        
        // Use kbIndexedFiles from server response (single source of truth from DO API)
        // The server queries DO API directly when completion is detected, ensuring we get the correct state
        if (result.kbIndexedFiles && Array.isArray(result.kbIndexedFiles)) {
          indexedFiles.value = result.kbIndexedFiles;
        }
        
        // Reload files to refresh the file list (for chips, etc.)
        // But we've already set indexedFiles from the completion response, so it won't be overwritten
        await loadFiles();
        
        // Ensure indexedFiles from completion response is preserved
        // loadFiles() may return stale data if userDoc hasn't been updated yet, but we have the correct data from DO API
        if (result.kbIndexedFiles && Array.isArray(result.kbIndexedFiles)) {
          indexedFiles.value = result.kbIndexedFiles;
        }
        
        emit('indexing-finished', { jobId, phase: 'complete' });
        
        // Reload agent info to update KB info (including indexed files and connection status)
        if (currentTab.value === 'agent') {
          await loadAgent();
        }
        
        // Attach KB to agent and generate patient summary
        await attachKBAndGenerateSummary();
        
        // Clear dirty flag since indexing completed successfully
        kbNeedsUpdate.value = false;
        
        // Clean up elapsed time interval
        if (elapsedTimeInterval.value) {
          clearInterval(elapsedTimeInterval.value);
          elapsedTimeInterval.value = null;
        }
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
          indexingKB.value = false;
        }, 5000);
      } else if (result.phase === 'error') {
        indexingStatus.value.phase = 'error';
        indexingStatus.value.error = result.error || 'Indexing failed';
        emit('indexing-finished', { jobId, phase: 'error', error: indexingStatus.value.error });
        
        // Clean up elapsed time interval
        if (elapsedTimeInterval.value) {
          clearInterval(elapsedTimeInterval.value);
          elapsedTimeInterval.value = null;
        }
        
        $q.notify({
          type: 'negative',
          message: `Indexing failed: ${indexingStatus.value.error}`
        });
      }
    } catch (err) {
      clearInterval(pollingInterval.value!);
      pollingInterval.value = null;
      if (elapsedTimeInterval.value) {
        clearInterval(elapsedTimeInterval.value);
        elapsedTimeInterval.value = null;
      }
      indexingKB.value = false;
      indexingStatus.value.phase = 'error';
      indexingStatus.value.error = err instanceof Error ? err.message : 'Failed to get indexing status';
      emit('indexing-finished', { jobId, phase: 'error', error: indexingStatus.value.error });
      console.error('Error polling indexing status:', err);
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: `Error checking indexing status: ${indexingStatus.value.error}`
        });
      }
    }
  }, POLL_INTERVAL_MS);
};

// Chat management methods
const selectChat = async (chat: SavedChat) => {
  try {
    let response;
    
    // If chat has a shareId, load it via shareId endpoint (for deep links)
    if (chat.shareId) {
      response = await fetch(`/api/load-chat-by-share/${chat.shareId}`, {
      credentials: 'include'
    });
    } else {
      // Otherwise, load chat via chatId
      response = await fetch(`/api/load-chat/${chat._id}`, {
        credentials: 'include'
      });
    }
    
    if (!response.ok) {
      throw new Error(`Failed to load chat: ${response.statusText}`);
    }
    
    const result = await response.json();
    const closed = await closeDialog();
    if (closed) {
    emit('chat-selected', result.chat);
    }
  } catch (err) {
    console.error('Failed to load full chat data:', err);
    // Fallback: emit the chat we have
    const closed = await closeDialog();
    if (closed) {
    emit('chat-selected', chat);
    }
  }
};

const copyChatLink = (chat: SavedChat) => {
  if (!chat.shareId) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'Create a deep link by saving this chat first.',
        position: 'top',
        timeout: 2000
      });
    }
    return;
  }

  const baseUrl = window.location.origin;
  const link = `${baseUrl}/chat/${chat.shareId}`;

  navigator.clipboard.writeText(link)
    .then(() => {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'positive',
          message: 'Deep link copied to clipboard',
          position: 'top',
          timeout: 3000,
          color: 'primary',
          textColor: 'white'
        });
      } else {
        alert('Deep link copied to clipboard');
      }
    })
    .catch(() => {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: 'Failed to copy link',
          position: 'top',
          timeout: 3000
        });
      } else {
        alert('Failed to copy link');
      }
    });
};

const confirmDeleteChat = (chat: SavedChat) => {
  if ($q && typeof $q.dialog === 'function') {
  $q.dialog({
    title: 'Delete Chat',
    message: 'Are you sure you want to delete this chat?',
    cancel: true,
    persistent: true
  }).onOk(() => {
    deleteChat(chat);
  });
  } else if (window.confirm('Are you sure you want to delete this chat?')) {
    deleteChat(chat);
  }
};

const deleteChat = async (chat: SavedChat) => {
  try {
    await deleteChatById(chat._id);

    // Remove from list
    sharedChats.value = sharedChats.value.filter(c => c._id !== chat._id);
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Chat deleted successfully'
    });
    }
  } catch (err) {
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to delete chat'
    });
    } else {
      console.error('Failed to delete chat:', err);
    }
  }
};

// Helper function to generate patient summary (actual generation logic)
const doGeneratePatientSummary = async () => {
  // Step 1: Attach KB to agent
  const attachResponse = await fetch('/api/attach-kb-to-agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      userId: props.userId
    })
  });

  if (!attachResponse.ok) {
    const errorData = await attachResponse.json();
    throw new Error(errorData.message || 'Failed to attach KB to agent');
  }

  const attachResult = await attachResponse.json();
  console.log('[KB] KB attached to agent:', attachResult);
  
  // Step 2: Generate patient summary
  indexingStatus.value.message = 'Generating patient summary...';
  emit('indexing-status-update', {
    jobId: currentIndexingJobId.value || '',
    phase: 'kb_setup',
    tokens: indexingStatus.value.tokens,
    filesIndexed: indexingStatus.value.filesIndexed,
    progress: 1.0
  });
  
  const summaryResponse = await fetch('/api/generate-patient-summary', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      userId: props.userId
    })
  });

  if (!summaryResponse.ok) {
    const errorData = await summaryResponse.json();
    throw new Error(errorData.message || 'Failed to generate patient summary');
  }

  const summaryResult = await summaryResponse.json();
  console.log('[KB] Patient summary generated:', summaryResult);
  
  // Check if there are empty slots
  const hasEmptySlots = patientSummaries.value.length < 3;
  
  if (hasEmptySlots) {
    // Automatically save with 'newest' strategy (just adds to array)
    await handleReplaceSummary('newest', summaryResult.summary);
  } else {
    // All slots full - show dialog to choose replace strategy
    savedCurrentSummaryForUndo.value = summaryResult.savedCurrentSummary || null;
    newSummaryToReplace.value = summaryResult.summary || '';
    showReplaceSummaryDialog.value = true;
  }
  
  // Update indexing status to show completion
  indexingStatus.value.message = 'Knowledge base indexed and patient summary generated!';
};

// Attach KB to agent and generate patient summary
const attachKBAndGenerateSummary = async () => {
  try {
    console.log('[KB] Attaching KB to agent and generating patient summary...');
    
    // Keep indexing status visible and update message
    indexingStatus.value.message = 'Attaching knowledge base to agent...';
    emit('indexing-status-update', {
      jobId: currentIndexingJobId.value || '',
      phase: 'kb_setup',
      tokens: indexingStatus.value.tokens,
      filesIndexed: indexingStatus.value.filesIndexed,
      progress: 1.0
    });
    
    // Always proceed directly - no pre-generation confirmation
    // If slots are full, the replace dialog will show after generation
    await doGeneratePatientSummary();
  } catch (error) {
    console.error('[KB] Error in attachKBAndGenerateSummary:', error);
    indexingStatus.value.message = `Error: ${error instanceof Error ? error.message : 'Failed to attach KB or generate summary'}`;
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to attach KB or generate summary'
      });
    }
  }
};

// Handle confirmation to replace summary (before generation)
const handleConfirmReplaceSummary = async () => {
  showSummaryAvailableModal.value = false;
  isSummaryModalBeforeGeneration.value = false;
  if (pendingSummaryGeneration.value) {
    try {
      await pendingSummaryGeneration.value();
    } catch (error) {
      console.error('[KB] Error generating summary after confirmation:', error);
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: error instanceof Error ? error.message : 'Failed to generate patient summary'
        });
      }
    } finally {
      pendingSummaryGeneration.value = null;
    }
  }
};

// Handle replace summary by index (when all slots are full)
const handleReplaceSummaryByIndex = async (indexToReplace: number) => {
  showReplaceSummaryDialog.value = false;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: newSummaryToReplace.value,
        replaceIndex: indexToReplace
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to save patient summary');
    }

    await response.json(); // Response processed, but result not needed
    
    // Reload summaries to get updated list
    await loadPatientSummary();
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!',
        timeout: 3000
      });
    }
    
    newSummaryToReplace.value = '';
  } catch (error) {
    console.error('[Summary] Error saving summary:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary',
        timeout: 5000
      });
    }
  }
};

// Handle replace summary dialog choice (for empty slots or keep strategy)
const handleReplaceSummary = async (replaceStrategy: 'keep' | 'oldest' | 'newest', summaryText?: string) => {
  showReplaceSummaryDialog.value = false;
  
  const summaryToSave = summaryText || newSummaryToReplace.value;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: summaryToSave,
        replaceStrategy: replaceStrategy
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to save patient summary');
    }

    await response.json(); // Response processed, but result not needed
    
    // Reload summaries to get updated list
    await loadPatientSummary();
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: replaceStrategy === 'keep' ? 'Current summary kept' : 'Patient summary saved successfully!',
        timeout: 3000
      });
    }
    
    newSummaryToReplace.value = '';
  } catch (error) {
    console.error('[Summary] Error saving summary:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary',
        timeout: 5000
      });
    }
  }
};

// Handle closing the summary modal
const handleCloseSummaryModal = () => {
  showSummaryAvailableModal.value = false;
  if (isSummaryModalBeforeGeneration.value) {
    // If it was before generation, cancel the pending generation
    pendingSummaryGeneration.value = null;
    isSummaryModalBeforeGeneration.value = false;
  } else {
    // If it was after generation, close the dialog
    handleCloseMyStuff();
  }
};

// Patient Summary modal handlers
const handleSaveSummary = async () => {
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: newPatientSummary.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save patient summary');
    }

    // Update local summary
    patientSummary.value = newPatientSummary.value;
    summaryEditText.value = newPatientSummary.value;
    isEditingSummaryTab.value = false;
    
    showSummaryAvailableModal.value = false;
    if (showSummaryViewModal.value) {
      showSummaryViewModal.value = false;
    }
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary'
      });
    }
  }
};

const handleCloseMyStuff = () => {
  showSummaryAvailableModal.value = false;
  emit('update:modelValue', false);
};

const handleEditSummary = () => {
  editingSummary.value = true;
};

const handleSaveEditedSummary = async () => {
  const summaryToSave = editingSummary.value ? summaryViewText.value : newPatientSummary.value;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: summaryToSave
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save patient summary');
    }

    // Update local values
    newPatientSummary.value = summaryToSave;
    patientSummary.value = summaryToSave;
    summaryEditText.value = summaryToSave;
    isEditingSummaryTab.value = false;
    editingSummary.value = false;
    showSummaryViewModal.value = false;
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary'
      });
    }
  }
};

const handleCloseWithoutSaving = () => {
  if (editingSummary.value) {
    // Revert changes
    summaryViewText.value = newPatientSummary.value;
    editingSummary.value = false;
  } else {
    showSummaryViewModal.value = false;
  }
};

// Patient Summary methods
// Helper function to format time ago
const getTimeAgo = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffDays > 0) {
    return `${diffDays} ${diffDays === 1 ? 'day' : 'days'}`;
  } else if (diffHours > 0) {
    return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'}`;
  } else {
    return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'}`;
  }
};

// Swap summary function
const swapSummary = async (index: number) => {
  try {
    const response = await fetch('/api/patient-summary/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        index: index
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to swap summary');
    }

    await response.json(); // Response processed, but result not needed
    // Reload summaries
    await loadPatientSummary();
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Summary swapped successfully',
        timeout: 3000
      });
    }
  } catch (error) {
    console.error('[Summary] Error swapping summary:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to swap summary',
        timeout: 5000
      });
    }
  }
};

const loadPrivacyFilter = async () => {
  loadingPrivacyFilter.value = true;
  privacyFilterError.value = '';
  privacyFilterResponse.value = '';

  try {
    // Always try to load existing mapping first (cumulative - never deleted)
    try {
      const loadResponse = await fetch('/api/privacy-filter-mapping', {
        credentials: 'include'
      });
      
      if (loadResponse.ok) {
        const loadData = await loadResponse.json();
        if (loadData.mapping && loadData.mapping.length > 0) {
          privacyFilterMapping.value = loadData.mapping;
        }
      }
    } catch (loadErr) {
      console.warn(`[PRIVACY] Could not load existing mapping:`, loadErr);
      privacyFilterMapping.value = [];
    }

    // Use originalMessages if available (unfiltered), otherwise fall back to props.messages
    const messagesToAnalyze = (props.originalMessages && props.originalMessages.length > 0) 
      ? props.originalMessages 
      : props.messages;
    
    // Check if we have messages to query Private AI
    if (!messagesToAnalyze || messagesToAnalyze.length === 0) {
      // Still show existing mapping if available - don't set error if mapping exists
      if (privacyFilterMapping.value.length === 0) {
        privacyFilterError.value = 'No chat messages available';
      }
      return;
    }

    // Prepare messages for Private AI query
    // Include all chat messages plus the privacy filter question
    // IMPORTANT: We only want names from the chat messages themselves, not from knowledge base documents
    const chatMessagesOnly = messagesToAnalyze.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
    
    const queryMessages = [
      ...chatMessagesOnly,
      {
        role: 'user' as const,
        content: 'Based ONLY on the chat messages above (ignore any information from your knowledge base or retrieved documents), what names of people are explicitly mentioned in this chat conversation? List only names that appear in the chat messages themselves.'
      }
    ];

    // Query Private AI
    const response = await fetch('/api/chat/digitalocean', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      credentials: 'include',
      body: JSON.stringify({
        messages: queryMessages,
        options: {
          stream: true
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || 'Failed to query Private AI');
    }

    // Read streaming response
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let responseText = '';

    if (!reader) {
      throw new Error('Failed to read response stream');
    }

    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      
      // Process complete lines (ending with \n\n)
      const lines = buffer.split('\n\n');
      // Keep the last incomplete line in buffer
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            
            // Only use delta for incremental content (like ChatInterface does)
            // Ignore content field to avoid duplication
            if (data.delta) {
              responseText += data.delta;
            }
            
            // Check if response is complete
            if (data.isComplete) {
              break;
            }
          } catch (e) {
            // Skip malformed JSON - might be partial chunk
          }
        }
      }
    }
    
    // Store the raw response
    privacyFilterResponse.value = responseText.trim();
    
    // Always check for new names and add them to existing mapping (cumulative)
    await createPseudonymMapping(responseText.trim());
  } catch (err) {
    console.error(`[PRIVACY] Error during privacy filter analysis:`, err);
    privacyFilterError.value = err instanceof Error ? err.message : 'Failed to analyze chat for names';
  } finally {
    loadingPrivacyFilter.value = false;
  }
};

const createPseudonymMapping = async (responseText: string) => {
  loadingRandomNames.value = true;
  
  try {
    // Load random names from backend API
    const randomNamesResponse = await fetch('/api/random-names');
    if (!randomNamesResponse.ok) {
      throw new Error('Failed to load random names');
    }
    
    const randomNamesData = await randomNamesResponse.json();
    const randomNamesList = randomNamesData.names || [];
    
    // Parse names from Privacy Filter response
    // Split by newlines and extract names (one per line, may have notes in parentheses)
    const responseLines = responseText.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('*'));
    
    const extractedNames: string[] = [];
    for (const line of responseLines) {
      // Extract name (may have notes in parentheses like "Adrian Gropper (also appears as...)")
      const nameMatch = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+(?:\.[A-Z])?)+)/);
      if (nameMatch) {
        extractedNames.push(nameMatch[1]);
      }
    }
    
    // Start with existing mapping (cumulative - never delete)
    const existingMapping = privacyFilterMapping.value || [];
    const existingOriginals = new Set(existingMapping.map(m => m.original));
    
    // Find new names that aren't in existing mapping
    const newNames = extractedNames.filter(name => !existingOriginals.has(name));
    
    if (newNames.length === 0) {
      return; // No new names, keep existing mapping
    }
    
    // Create pseudonym mapping for new names only
    const newMappings: Array<{ original: string; pseudonym: string }> = [];
    const usedRandomNames = new Set<number>();
    
    // Track which random names are already used in existing mapping
    existingMapping.forEach((m: { original: string; pseudonym: string }) => {
      // Extract the random name from pseudonym (e.g., "Emily45 Johnson67" -> "Emily Johnson")
      const pseudonymParts = m.pseudonym.split(/\s+/);
      if (pseudonymParts.length >= 2) {
        const firstName = pseudonymParts[0].replace(/\d+$/, ''); // Remove trailing numbers
        const lastName = pseudonymParts[1].replace(/\d+$/, ''); // Remove trailing numbers
        const randomName = `${firstName} ${lastName}`;
        const index = randomNamesList.findIndex((name: string) => name === randomName);
        if (index >= 0) {
          usedRandomNames.add(index);
        }
      }
    });
    
    for (const originalName of newNames) {
      // Pick a random name from the list (without replacement to avoid duplicates)
      let randomIndex: number;
      let attempts = 0;
      do {
        randomIndex = Math.floor(Math.random() * randomNamesList.length);
        attempts++;
        // If we've used all names, reset (allow reuse)
        if (attempts > randomNamesList.length * 2) {
          usedRandomNames.clear();
          break;
        }
      } while (usedRandomNames.has(randomIndex));
      
      usedRandomNames.add(randomIndex);
      const randomName = randomNamesList[randomIndex];
      
      // Split into first and last name
      const nameParts = randomName.split(/\s+/);
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ') || nameParts[1] || '';
      
      // Generate random numbers (10-99) for first and last name
      const firstNum = Math.floor(Math.random() * 90) + 10; // 10-99
      const lastNum = Math.floor(Math.random() * 90) + 10; // 10-99
      
      // Create pseudonym: "FirstNameXX LastNameYY"
      const pseudonym = lastName 
        ? `${firstName}${firstNum} ${lastName}${lastNum}`
        : `${firstName}${firstNum}`;
      
      // Validate pseudonym before adding
      if (!pseudonym || pseudonym.trim() === '') {
        console.error(`[PRIVACY] ERROR: Failed to create pseudonym for "${originalName}" - pseudonym is empty!`);
        continue; // Skip this name
      }
      
      newMappings.push({ original: originalName, pseudonym });
    }
    
    // Merge new mappings with existing ones (cumulative)
    const updatedMapping = [...existingMapping, ...newMappings];
    privacyFilterMapping.value = updatedMapping;
    
    // Save updated mapping to user document
    try {
      const saveResponse = await fetch('/api/privacy-filter-mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ mapping: updatedMapping })
      });
      
      if (!saveResponse.ok) {
        console.warn(`[PRIVACY] Failed to save mapping:`, await saveResponse.text());
      }
    } catch (saveErr) {
      console.error(`[PRIVACY] Error saving mapping:`, saveErr);
      // Don't fail the whole operation if save fails
    }
  } catch (err) {
    console.error(`[PRIVACY] Error creating pseudonym mapping:`, err);
    privacyFilterMapping.value = [];
  } finally {
    loadingRandomNames.value = false;
  }
};

const filterCurrentChat = () => {
  // Use originalMessages if available and has same length as props.messages (unfiltered), otherwise use props.messages
  // This ensures we always filter the correct number of messages
  const messagesToFilter = (props.originalMessages && props.originalMessages.length > 0 && props.originalMessages.length === props.messages.length) 
    ? props.originalMessages 
    : props.messages;
  
  if (!messagesToFilter || messagesToFilter.length === 0) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'No chat messages available to filter',
        timeout: 3000
      });
    }
    return;
  }
  
  if (privacyFilterMapping.value.length === 0) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'No pseudonym mapping available. Please analyze the chat first.',
        timeout: 3000
      });
    }
    return;
  }
  
  // Track which names were pseudonymized
  const pseudonymizedNames: Array<{ original: string; pseudonym: string }> = [];
  
  // Create filtered messages by replacing names with pseudonyms
  const filteredMessages: Message[] = messagesToFilter.map(msg => {
    let filteredContent = msg.content;
    
    // Replace each original name with its pseudonym
    // Sort by length (longest first) to avoid partial replacements
    // (e.g., "John Smith" before "John")
    const sortedMappings = [...privacyFilterMapping.value].sort((a, b) => b.original.length - a.original.length);
    
    for (const mapping of sortedMappings) {
      const original = mapping.original;
      const pseudonym = mapping.pseudonym;
      
      // Validate pseudonym before using it
      if (!pseudonym || typeof pseudonym !== 'string' || pseudonym.trim() === '') {
        continue; // Skip this mapping
      }
      
      // Escape special regex characters
      const escapedOriginal = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      // For multi-word names (e.g., "John Smith"), match as a whole phrase with word boundaries
      // For single-word names, use word boundaries on both sides
      // Case-insensitive matching
      const regex = new RegExp(`\\b${escapedOriginal}\\b`, 'gi');
      const beforeReplace = filteredContent;
      filteredContent = filteredContent.replace(regex, pseudonym);
      
      // Track if this name was actually replaced in this message
      if (beforeReplace !== filteredContent && !pseudonymizedNames.some(n => n.original === original)) {
        pseudonymizedNames.push({ original, pseudonym });
      }
    }
    
    return {
      ...msg,
      content: filteredContent
    };
  });
  
  
  // Emit filtered messages to parent component
  emit('messages-filtered', filteredMessages);
  
  if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: `Filtered ${filteredMessages.length} messages with pseudonyms`,
      timeout: 3000
    });
  }
};

const loadDiary = async () => {
  loadingDiary.value = true;
  diaryError.value = '';

  try {
    const response = await fetch(`/api/patient-diary?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch diary: ${response.statusText}`);
    }
    
    const result = await response.json();
    diaryEntries.value = result.entries || [];
    
    // Assign bubbleIds to entries that don't have them
    // Group entries sequentially, but respect closed bubbles
    let currentBubbleId: string | null = null;
    for (const entry of diaryEntries.value) {
      if (!entry.bubbleId) {
        // Entry doesn't have a bubbleId - assign one
        if (currentBubbleId && !closedBubbleIds.value.has(currentBubbleId)) {
          // Last bubble is open - add to it
          entry.bubbleId = currentBubbleId;
        } else {
          // No bubble or last bubble is closed - create new bubble
          currentBubbleId = `bubble-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          entry.bubbleId = currentBubbleId;
        }
      } else {
        // Entry has a bubbleId - use it as current
        currentBubbleId = entry.bubbleId;
      }
    }
    
    // Load closed bubble IDs from entries that have bubbleId and are posted
    // Mark bubbles as closed if any entry in the bubble is posted
    const bubbleMap = new Map<string, boolean>();
    for (const entry of diaryEntries.value) {
      if (entry.bubbleId) {
        const hasPosted = entry.posted === true;
        if (!bubbleMap.has(entry.bubbleId)) {
          bubbleMap.set(entry.bubbleId, hasPosted);
        } else {
          bubbleMap.set(entry.bubbleId, bubbleMap.get(entry.bubbleId) || hasPosted);
        }
      }
    }
    closedBubbleIds.value = new Set(
      Array.from(bubbleMap.entries())
        .filter(([_, hasPosted]) => hasPosted)
        .map(([bubbleId, _]) => bubbleId)
    );
    
    // Scroll to bottom after loading
    await nextTick();
    if (diaryMessagesRef.value) {
      diaryMessagesRef.value.scrollTop = diaryMessagesRef.value.scrollHeight;
    }
  } catch (err) {
    diaryError.value = err instanceof Error ? err.message : 'Failed to load diary';
  } finally {
    loadingDiary.value = false;
  }
};

const addDiaryEntry = async () => {
  const message = diaryInputText.value.trim();
  if (!message || isSavingDiary.value) {
    return;
  }

  isSavingDiary.value = true;

  try {
    const dateTime = new Date().toISOString();
    
    // Determine which bubble this entry belongs to BEFORE creating it
    // If the last bubble is closed, create a new bubble. Otherwise, add to the last bubble.
    let bubbleId: string;
    if (diaryBubbles.value.length > 0) {
      const lastBubble = diaryBubbles.value[diaryBubbles.value.length - 1];
      if (lastBubble.closed) {
        // Last bubble is closed - create new bubble
        bubbleId = `bubble-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      } else {
        // Last bubble is open - add to it
        bubbleId = lastBubble.id;
      }
    } else {
      // No bubbles yet - create first bubble
      bubbleId = `bubble-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    const entryData = {
      message,
      dateTime,
      bubbleId
    };

    const response = await fetch('/api/patient-diary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        entry: entryData
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || 'Failed to save diary entry');
    }

    const result = await response.json();
    
    // Add the new entry to the list with its bubbleId
    const newEntry = {
      id: result.entryId,
      message,
      dateTime,
      bubbleId
    };
    diaryEntries.value.push(newEntry);

    // Clear input
    diaryInputText.value = '';

    // Scroll to bottom to show new entry
    await nextTick();
    if (diaryMessagesRef.value) {
      diaryMessagesRef.value.scrollTop = diaryMessagesRef.value.scrollHeight;
    }

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Diary entry saved',
        timeout: 2000
      });
    }
  } catch (error) {
    console.error('[Diary] Error saving entry:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save diary entry',
        timeout: 3000
      });
    }
  } finally {
    isSavingDiary.value = false;
  }
};

// Track which bubbles have been closed (posted)
const closedBubbleIds = ref<Set<string>>(new Set());

// Group diary entries into bubbles by bubbleId
// Each entry has a bubbleId. Group entries by their bubbleId.
const diaryBubbles = computed(() => {
  if (diaryEntries.value.length === 0) {
    return [];
  }

  // Group entries by bubbleId
  const bubbleMap = new Map<string, Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>>();
  
  for (const entry of diaryEntries.value) {
    const bubbleId = entry.bubbleId || 'no-bubble-id';
    if (!bubbleMap.has(bubbleId)) {
      bubbleMap.set(bubbleId, []);
    }
    bubbleMap.get(bubbleId)!.push(entry);
  }

  // Convert to bubble array, sorted by first entry's dateTime
  const bubbles: Array<{ 
    id: string;
    entries: Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>; 
    lastDateTime: string;
    closed: boolean;
  }> = [];

  for (const [bubbleId, entries] of bubbleMap.entries()) {
    // Sort entries by dateTime
    const sortedEntries = [...entries].sort((a, b) => 
      new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime()
    );
    
    const lastDateTime = sortedEntries[sortedEntries.length - 1]?.dateTime || '';
    const isClosed = closedBubbleIds.value.has(bubbleId);
    
    bubbles.push({
      id: bubbleId,
      entries: sortedEntries,
      lastDateTime,
      closed: isClosed
    });
  }

  // Sort bubbles by first entry's dateTime
  bubbles.sort((a, b) => {
    const dateA = new Date(a.entries[0]?.dateTime || 0);
    const dateB = new Date(b.entries[0]?.dateTime || 0);
    return dateA.getTime() - dateB.getTime();
  });

  return bubbles;
});

const formatDiaryDateTime = (dateTimeString: string): string => {
  const date = new Date(dateTimeString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  // Format: "Today at 3:45 PM" or "Yesterday at 2:30 PM" or "Jan 15, 2025 at 10:30 AM"
  const timeStr = date.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
  
  if (diffMins < 1) {
    return `Just now`;
  } else if (diffMins < 60) {
    return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  } else if (diffDays === 0) {
    return `Today at ${timeStr}`;
  } else if (diffDays === 1) {
    return `Yesterday at ${timeStr}`;
  } else {
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
    return `${dateStr} at ${timeStr}`;
  }
};

const formatDiaryTime = (dateTimeString: string): string => {
  const date = new Date(dateTimeString);
  return date.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
};

const postBubbleToChat = (bubble: { id: string; entries: Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>; lastDateTime: string; closed: boolean }) => {
  // Format the bubble content
  const bubbleContent = bubble.entries
    .map(entry => {
      const time = formatDiaryTime(entry.dateTime);
      return `${time} ${entry.message}`;
    })
    .join('\n');
  
  const diaryMessage = `Here is my latest patient diary:\n\n${bubbleContent}`;
  
  // Emit to parent to add to chat
  emit('diary-posted', diaryMessage);
  
  // Mark this bubble as closed by adding its bubble ID to closedBubbleIds
  // This marks the bubble as closed so the next message starts a new bubble
  closedBubbleIds.value.add(bubble.id);
  
  // Also update local entries (for backend persistence)
  bubble.entries.forEach(entry => {
    const localEntry = diaryEntries.value.find(e => e.id === entry.id);
    if (localEntry) {
      localEntry.posted = true;
    }
  });
  
  // Update backend to mark entries as posted
  updateDiaryEntriesPosted(bubble.entries.map(e => e.id));
  
  if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Diary posted to chat',
      timeout: 2000
    });
  }
};

const updateDiaryEntriesPosted = async (entryIds: string[]) => {
  try {
    await fetch('/api/patient-diary/mark-posted', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        entryIds
      })
    });
  } catch (error) {
    console.error('[Diary] Error marking entries as posted:', error);
  }
};

// Shared References Functions
const loadReferences = async () => {
  loadingReferences.value = true;
  referencesError.value = '';

  try {
    const response = await fetch(`/api/user-files?userId=${props.userId}&subfolder=References`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch references: ${response.statusText}`);
    }

    const result = await response.json();
    referenceFiles.value = (result.files || []).map((file: any) => ({
      fileName: file.fileName,
      bucketKey: file.bucketKey,
      fileSize: file.fileSize,
      uploadedAt: file.uploadedAt,
      fileType: file.fileType,
      fileUrl: file.fileUrl
    }));
  } catch (err) {
    referencesError.value = err instanceof Error ? err.message : 'Failed to load references';
  } finally {
    loadingReferences.value = false;
  }
};

const triggerReferenceFileInput = () => {
  referenceFileInput.value?.click();
};

const handleReferenceFileSelect = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  
  if (!file) return;

  isUploadingReference.value = true;

  try {
    // Check file size
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 50MB.`);
    }

    // Upload to References subfolder
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('subfolder', 'References');

    const uploadResponse = await fetch('/api/files/upload', {
      method: 'POST',
      credentials: 'include',
      body: uploadFormData
    });

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json();
      throw new Error(errorData.message || errorData.error || 'Failed to upload file');
    }

    const uploadResult = await uploadResponse.json();

    // Update user document with file metadata
    try {
      await fetch('/api/user-file-metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          userId: props.userId,
          fileMetadata: {
            fileName: uploadResult.fileInfo.fileName,
            bucketKey: uploadResult.fileInfo.bucketKey,
            bucketPath: uploadResult.fileInfo.userFolder,
            fileSize: uploadResult.fileInfo.size,
            fileType: file.name.endsWith('.pdf') ? 'pdf' : (file.name.endsWith('.md') ? 'markdown' : 'text'),
            uploadedAt: uploadResult.fileInfo.uploadedAt,
            isReference: true // Mark as reference file
          }
        })
      });
    } catch (error) {
      console.warn('Failed to save file metadata to user document:', error);
    }

    // Reload references list
    await loadReferences();

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Reference file uploaded successfully',
        timeout: 2000
      });
    }
  } catch (error) {
    console.error('Error uploading reference file:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to upload reference file',
        timeout: 3000
      });
    }
  } finally {
    isUploadingReference.value = false;
    // Reset input
    if (input) {
      input.value = '';
    }
  }
};

const viewReferenceFile = (file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }) => {
  // Use the same PDF viewer modal as other files
  if (file.fileType === 'pdf' && file.bucketKey) {
    viewFileInPdfViewer({
      fileName: file.fileName,
      bucketKey: file.bucketKey,
      fileSize: file.fileSize,
      uploadedAt: file.uploadedAt,
      inKnowledgeBase: false
    });
  } else {
    // For text files, use PDF viewer modal (it can handle text too)
    viewFileInPdfViewer({
      fileName: file.fileName,
      bucketKey: file.bucketKey,
      fileSize: file.fileSize,
      uploadedAt: file.uploadedAt,
      inKnowledgeBase: false
    });
  }
};

const deleteReferenceFile = async (file: { fileName: string; bucketKey: string }) => {
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Delete Reference File',
      message: `Are you sure you want to delete "${file.fileName}"?`,
      persistent: true,
      ok: {
        label: 'Delete',
        color: 'negative',
        flat: false
      },
      cancel: {
        label: 'Cancel',
        color: 'grey',
        flat: true
      }
    }).onOk(async () => {
      try {
        const response = await fetch('/api/files/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.userId,
            bucketKey: file.bucketKey
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to delete file');
        }

        // Remove from list
        referenceFiles.value = referenceFiles.value.filter(f => f.bucketKey !== file.bucketKey);

        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'positive',
            message: 'Reference file deleted successfully',
            timeout: 2000
          });
        }
      } catch (error) {
        console.error('Error deleting reference file:', error);
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'negative',
            message: error instanceof Error ? error.message : 'Failed to delete reference file',
            timeout: 3000
          });
        }
      }
    });
  }
};

const showAddReferenceToChatDialog = (file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }) => {
  selectedReferenceForChat.value = file;
  
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Add Reference to Chat',
      message: `Would you like to add "${file.fileName}" to the current chat? Reference files are not considered for indexing in the patient's knowledge base.`,
      persistent: true,
      ok: {
        label: 'ADD TO CHAT',
        color: 'primary',
        flat: false
      },
      cancel: {
        label: 'CANCEL',
        color: 'grey',
        flat: true
      }
    }).onOk(() => {
      addReferenceToChat(file);
    }).onCancel(() => {
      selectedReferenceForChat.value = null;
    }).onDismiss(() => {
      selectedReferenceForChat.value = null;
    });
  }
};

const addReferenceToChat = (file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }) => {
  // Emit event to add file to chat
  emit('reference-file-added', {
    fileName: file.fileName,
    bucketKey: file.bucketKey,
    fileSize: file.fileSize,
    uploadedAt: file.uploadedAt,
    fileType: file.fileType || 'text',
    fileUrl: file.fileUrl,
    isReference: true
  });
  
  selectedReferenceForChat.value = null;
  
  if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Reference file added to chat',
      timeout: 2000
    });
  }
};

const deleteBubble = async (bubble: { id: string; entries: Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>; lastDateTime: string; closed: boolean }) => {
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Delete Diary Bubble',
      message: `Are you sure you want to delete this diary bubble with ${bubble.entries.length} entr${bubble.entries.length === 1 ? 'y' : 'ies'}?`,
      persistent: true,
      ok: {
        label: 'Delete',
        color: 'negative',
        flat: false
      },
      cancel: {
        label: 'Cancel',
        color: 'grey',
        flat: true
      }
    }).onOk(async () => {
      try {
        const entryIds = bubble.entries.map(e => e.id);
        
        const response = await fetch('/api/patient-diary/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.userId,
            entryIds
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
          throw new Error(errorData.error || 'Failed to delete diary entries');
        }

        // Remove entries from local state
        diaryEntries.value = diaryEntries.value.filter(entry => !entryIds.includes(entry.id));
        
        // Also remove from closed bubble set
        if (closedBubbleIds.value.has(bubble.id)) {
          closedBubbleIds.value.delete(bubble.id);
        }

        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'positive',
            message: 'Diary bubble deleted',
            timeout: 2000
          });
        }
      } catch (error) {
        console.error('[Diary] Error deleting bubble:', error);
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'negative',
            message: error instanceof Error ? error.message : 'Failed to delete diary bubble',
            timeout: 3000
          });
        }
      }
    });
  }
};

const loadPatientSummary = async () => {
  loadingSummary.value = true;
  summaryError.value = '';

  try {
    const response = await fetch(`/api/patient-summary?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch patient summary: ${response.statusText}`);
    }
    
    const result = await response.json();
    const loadedSummary = result.summary || '';
    patientSummary.value = loadedSummary;
    summaryEditText.value = loadedSummary;
    patientSummaries.value = result.summaries || [];
    if (!loadedSummary) {
      isEditingSummaryTab.value = false;
    }
  } catch (err) {
    summaryError.value = err instanceof Error ? err.message : 'Failed to load patient summary';
  } finally {
    loadingSummary.value = false;
  }
};

const requestNewSummary = async () => {
  // Always proceed directly - no pre-generation confirmation
  // If slots are full, the replace dialog will show after generation
  loadingSummary.value = true;
  summaryError.value = '';

  try {
    console.log('[Summary] Requesting new patient summary...');
    
    const response = await fetch('/api/generate-patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to generate patient summary');
    }

    const result = await response.json();
    console.log('[Summary] Patient summary generated:', result);
    
    // Check if there are empty slots
    const hasEmptySlots = patientSummaries.value.length < 3;
    
    if (hasEmptySlots) {
      // Automatically save with 'newest' strategy (just adds to array)
      await handleReplaceSummary('newest', (result.summary || '').trim());
    } else {
      // All slots full - show dialog to choose which summary to replace
      savedCurrentSummaryForUndo.value = result.savedCurrentSummary || null;
      newSummaryToReplace.value = (result.summary || '').trim();
      showReplaceSummaryDialog.value = true;
    }
  } catch (error) {
    console.error('[Summary] Error generating patient summary:', error);
    summaryError.value = error instanceof Error ? error.message : 'Failed to generate patient summary';
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: summaryError.value,
        timeout: 5000
      });
    }
  } finally {
    loadingSummary.value = false;
  }
};


const startSummaryEdit = () => {
  summaryEditText.value = patientSummary.value || '';
  isEditingSummaryTab.value = true;
};

const cancelSummaryEdit = () => {
  isEditingSummaryTab.value = false;
  summaryEditText.value = '';
};

const saveSummaryFromTab = async () => {
  if (!props.userId) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'User ID is required to save the summary'
      });
    }
    return;
  }

  const summaryToSave = summaryEditText.value.trim();
  if (!summaryToSave) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'Summary cannot be empty'
      });
    }
    return;
  }

  isSavingSummary.value = true;

  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: summaryToSave
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(errorData.message || 'Failed to save patient summary');
    }

    patientSummary.value = summaryToSave;
    newPatientSummary.value = summaryToSave;
    summaryViewText.value = summaryToSave;
    summaryEditText.value = summaryToSave;
    isEditingSummaryTab.value = false;

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    console.error('[Summary] Error saving summary:', error);
    const message = error instanceof Error ? error.message : 'Failed to save patient summary';
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message
      });
    }
  } finally {
    isSavingSummary.value = false;
  }
};

const sortedSharedChats = computed(() => {
  return [...sharedChats.value].sort((a, b) => {
    const dateA = new Date(a.updatedAt || a.createdAt);
    const dateB = new Date(b.updatedAt || b.createdAt);
    return dateB.getTime() - dateA.getTime();
  });
});

const closeDialog = async (): Promise<boolean> => {
  // Check if indexing is in progress
  if (indexingKB.value && currentIndexingJobId.value) {
    const result = await new Promise<'ok' | 'cancel' | 'dismiss'>((resolve) => {
      if ($q && typeof $q.dialog === 'function') {
        $q.dialog({
          title: 'Indexing in progress',
          message: 'Knowledge base indexing is still in progress and could take up to 60 minutes. What would you like to do?',
          persistent: true,
          ok: {
            label: 'OK',
            color: 'primary',
            flat: false
          },
          cancel: {
            label: 'Cancel Indexing',
            color: 'negative',
            flat: true
          }
        }).onOk(() => resolve('ok'))
          .onCancel(() => resolve('cancel'))
          .onDismiss(() => resolve('dismiss'));
      } else {
        const action = window.confirm('Indexing is in progress. Click OK to continue watching, or Cancel to cancel indexing.');
        resolve(action ? 'ok' : 'cancel');
      }
    });

    if (result === 'cancel') {
      // Cancel indexing and restore files
      await cancelIndexingAndRestore();
      // After cancel, allow closing
    } else if (result === 'ok' || result === 'dismiss') {
      // User wants to stay and watch - don't close
      return false;
    }
  }

  if (hasUnsavedChanges.value) {
    const confirmClose = await new Promise<boolean>((resolve) => {
      if ($q && typeof $q.dialog === 'function') {
        $q.dialog({
          title: 'Unsaved changes',
          message: 'You have unsaved changes in My Agent or Patient Summary. Close without saving?',
          cancel: true,
          persistent: true,
          ok: {
            label: 'Discard and Close',
            color: 'negative'
          }
        }).onOk(() => resolve(true))
          .onCancel(() => resolve(false))
          .onDismiss(() => resolve(false));
      } else {
        const shouldClose = window.confirm('You have unsaved changes in My Agent or Patient Summary. Close without saving?');
        resolve(shouldClose);
      }
    });

    if (!confirmClose) {
      return false;
    }

    if (hasUnsavedAgentChanges.value) {
      cancelEdit();
    }

    if (hasUnsavedSummaryChanges.value) {
      cancelSummaryEdit();
    }
  }

  isOpen.value = false;
  return true;
};

watch(() => props.modelValue, async (newValue) => {
  isOpen.value = newValue;
  if (newValue) {
    // Set initial tab if provided
    if (props.initialTab) {
      currentTab.value = props.initialTab;
    }
    
    // Check for active indexing job and restore polling if needed
    try {
      const statusResponse = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, {
        credentials: 'include'
      });
      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        if (statusData.kbLastIndexingJobId && !currentIndexingJobId.value) {
          // Check if indexing is still active by querying job status
          try {
            const jobStatusResponse = await fetch(`/api/kb-indexing-status/${statusData.kbLastIndexingJobId}?userId=${encodeURIComponent(props.userId)}`, {
              credentials: 'include'
            });
            if (jobStatusResponse.ok) {
              const jobStatusData = await jobStatusResponse.json();
              // Only restore if job is still in progress (not completed or failed)
              if (jobStatusData.phase && jobStatusData.phase !== 'complete' && jobStatusData.phase !== 'error') {
                console.log('[KB] Restoring indexing state for job:', statusData.kbLastIndexingJobId);
                currentIndexingJobId.value = statusData.kbLastIndexingJobId;
                indexingKB.value = true;
                indexingStatus.value = {
                  phase: jobStatusData.phase || 'indexing',
                  message: jobStatusData.message || 'Indexing in progress...',
                  kb: jobStatusData.kb || statusData.kbId || '',
                  tokens: jobStatusData.tokens || '0',
                  filesIndexed: jobStatusData.filesIndexed || 0,
                  progress: jobStatusData.progress || 0,
                  error: jobStatusData.error || ''
                };
                // Start polling for progress
                pollIndexingProgress(statusData.kbLastIndexingJobId);
              }
            }
          } catch (jobStatusError) {
            console.warn('Failed to check job status on dialog open:', jobStatusError);
          }
        }
      }
    } catch (statusError) {
      console.warn('Failed to check indexing status on dialog open:', statusError);
    }
    
    // Load data when dialog opens
    if (currentTab.value === 'files') {
      loadFiles();
    } else if (currentTab.value === 'agent') {
      loadAgent();
    } else if (currentTab.value === 'chats') {
      loadSharedChats();
    } else if (currentTab.value === 'privacy') {
      loadPrivacyFilter();
    } else if (currentTab.value === 'diary') {
      loadDiary();
    } else if (currentTab.value === 'references') {
      loadReferences();
    }
  }
});

watch(() => props.initialTab, (newTab) => {
  if (newTab && isOpen.value) {
    currentTab.value = newTab;
  }
});

watch(isOpen, (newValue) => {
  emit('update:modelValue', newValue);
});

watch(currentTab, (newTab) => {
  if (isOpen.value) {
    if (newTab === 'files') {
      loadFiles();
    } else if (newTab === 'agent') {
      loadAgent();
    } else if (newTab === 'chats') {
      loadSharedChats();
    } else if (newTab === 'summary') {
      loadPatientSummary();
    } else if (newTab === 'lists') {
      // Lists component handles its own data loading
    } else if (newTab === 'privacy') {
      loadPrivacyFilter();
    } else if (newTab === 'diary') {
      loadDiary();
    } else if (newTab === 'references') {
      loadReferences();
    }
  }
});

// Clean up polling interval on component unmount
onUnmounted(() => {
  if (pollingInterval.value) {
    clearInterval(pollingInterval.value);
    pollingInterval.value = null;
  }
  if (elapsedTimeInterval.value) {
    clearInterval(elapsedTimeInterval.value);
    elapsedTimeInterval.value = null;
  }
});
</script>

<style scoped lang="scss">
.q-item {
  cursor: default;
}
</style>
