export async function deleteChatById(chatId: string): Promise<void> {
  if (!chatId) {
    throw new Error('Chat ID is required');
  }

  const response = await fetch(`/api/delete-chat/${encodeURIComponent(chatId)}`, {
    method: 'DELETE',
    credentials: 'include'
  });

  if (!response.ok) {
    let message = response.statusText || 'Failed to delete chat';
    try {
      const errorData = await response.json();
      if (errorData?.message) {
        message = errorData.message;
      }
    } catch (err) {
      // Ignore JSON parse errors and fall back to statusText
    }
    throw new Error(message);
  }
}

