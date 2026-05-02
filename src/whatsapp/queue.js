const chatQueues = new Map();

export function enqueueChatTask(chatId, task) {
  const previousTask = chatQueues.get(chatId) || Promise.resolve();
  const nextTask = previousTask.catch(() => undefined).then(task);

  chatQueues.set(chatId, nextTask);

  nextTask.finally(() => {
    if (chatQueues.get(chatId) === nextTask) {
      chatQueues.delete(chatId);
    }
  });

  return nextTask;
}
