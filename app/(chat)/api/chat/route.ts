import {
  type Message,
  convertToCoreMessages,
  createDataStreamResponse,
  streamText,
} from 'ai';
import { z } from 'zod';

import { auth, signIn } from '@/app/(auth)/auth';
import { customModel } from '@/lib/ai';
import { models, reasoningModels } from '@/lib/ai/models';
import { rateLimiter } from '@/lib/rate-limit';
import {
  systemPrompt,
} from '@/lib/ai/prompts';
import {
  deleteChatById,
  getChatById,
  getUser,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import {
  generateUUID,
  getMostRecentUserMessage,
  sanitizeResponseMessages,
} from '@/lib/utils';

import { generateTitleFromUserMessage } from '../../actions';
import FirecrawlApp from '@mendable/firecrawl-js';
import { runDeepResearch } from '@/lib/ai/deep-research';
import { serperSearch } from '@/lib/search';

type AllowedTools =
  | 'deepResearch'
  | 'search'
  | 'extract'
  | 'scrape';


const firecrawlTools: AllowedTools[] = ['search', 'extract', 'scrape'];

const allTools: AllowedTools[] = [...firecrawlTools, 'deepResearch'];

const app = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY || '',
});

// const reasoningModel = customModel(process.env.REASONING_MODEL || 'o1-mini', true);

export async function POST(request: Request) {
  const maxDuration = process.env.MAX_DURATION
    ? Number.parseInt(process.env.MAX_DURATION)
    : 300; 
  
  const {
    id,
    messages,
    modelId,
    reasoningModelId,
    experimental_deepResearch = false,
  }: { 
    id: string; 
    messages: Array<Message>; 
    modelId: string; 
    reasoningModelId: string;
    experimental_deepResearch?: boolean;
  } = await request.json();

  let session = await auth();

  // If no session exists, create an anonymous session
  if (!session?.user) {
    try {
      const result = await signIn('credentials', {
        redirect: false,
      });

      if (result?.error) {
        console.error('Failed to create anonymous session:', result.error);
        return new Response('Failed to create anonymous session', {
          status: 500,
        });
      }

      // Wait for the session to be fully established
      let retries = 3;
      while (retries > 0) {
        session = await auth();
        
        if (session?.user?.id) {
          // Verify user exists in database
          const users = await getUser(session.user.email as string);
          if (users.length > 0) {
            break;
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        retries--;
      }

      if (!session?.user) {
        console.error('Failed to get session after creation');
        return new Response('Failed to create session', { status: 500 });
      }
    } catch (error) {
      console.error('Error creating anonymous session:', error);
      return new Response('Failed to create anonymous session', {
        status: 500,
      });
    }
  }

  if (!session?.user?.id) {
    return new Response('Failed to create session', { status: 500 });
  }

  // Verify user exists in database before proceeding
  try {
    const users = await getUser(session.user.email as string);
    if (users.length === 0) {
      console.error('User not found in database:', session.user);
      return new Response('User not found', { status: 500 });
    }
  } catch (error) {
    console.error('Error verifying user:', error);
    return new Response('Failed to verify user', { status: 500 });
  }

  // Apply rate limiting
  const identifier = session.user.id;
  const { success, limit, reset, remaining } =
    await rateLimiter.limit(identifier);

  if (!success) {
    return new Response(`Too many requests`, { status: 429 });
  }

  const model = models.find((model) => model.id === modelId);
  const reasoningModel = reasoningModels.find((model) => model.id === reasoningModelId);

  if (!model || !reasoningModel) {
    return new Response('Model not found', { status: 404 });
  }

  const coreMessages = convertToCoreMessages(messages);
  const userMessage = getMostRecentUserMessage(coreMessages);

  if (!userMessage) {
    return new Response('No user message found', { status: 400 });
  }

  const chat = await getChatById({ id });

  if (!chat) {
    const title = await generateTitleFromUserMessage({ message: userMessage });
    await saveChat({ id, userId: session.user.id, title });
  }

  const userMessageId = generateUUID();

  await saveMessages({
    messages: [
      { ...userMessage, id: userMessageId, createdAt: new Date(), chatId: id },
    ],
  });

  return createDataStreamResponse({
    execute: (dataStream) => {
      dataStream.writeData({
        type: 'user-message-id',
        content: userMessageId,
      });

      const result = streamText({
        // Router model
        model: customModel(model.apiIdentifier, false),
        system: systemPrompt,
        messages: coreMessages,
        maxSteps: 10,
        experimental_activeTools: experimental_deepResearch ? allTools : firecrawlTools,
        tools: {
          search: {
            description:
              "Search for web pages. Normally you should call the extract tool after this one to get a spceific data point if search doesn't the exact data you need.",
            parameters: z.object({
              query: z
                .string()
                .describe('Search query to find relevant web pages'),
              maxResults: z
                .number()
                .optional()
                .describe('Maximum number of results to return (default 10)'),
            }),
            execute: async ({ query, maxResults = 5 }) => {
              const serperApiKey = process.env.SERPER_API_KEY;
              if (!serperApiKey) {
                return { error: 'SERPER_API_KEY not configured', success: false };
              }
              try {
                const searchResult = await serperSearch(query, serperApiKey, maxResults);
                if (!searchResult.success) {
                  return { error: `Search failed: ${searchResult.error}`, success: false };
                }
                const resultsWithFavicons = searchResult.data.map((result) => {
                  const url = new URL(result.url);
                  const favicon = `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=32`;
                  return { ...result, favicon };
                });
                return { data: resultsWithFavicons, success: true };
              } catch (error: any) {
                return { error: `Search failed: ${error.message}`, success: false };
              }
            },
          },
          extract: {
            description:
              'Extract structured data from web pages. Use this to get whatever data you need from a URL. Any time someone needs to gather data from something, use this tool.',
            parameters: z.object({
              urls: z.array(z.string()).describe(
                'Array of URLs to extract data from',
                // , include a /* at the end of each URL if you think you need to search for other pages insides that URL to extract the full data from',
              ),
              prompt: z
                .string()
                .describe('Description of what data to extract'),
            }),
            execute: async ({ urls, prompt }) => {
              try {
                const scrapeResult = await app.extract(urls, {
                  prompt,
                });

                if (!scrapeResult.success) {
                  return {
                    error: `Failed to extract data: ${scrapeResult.error}`,
                    success: false,
                  };
                }

                return {
                  data: scrapeResult.data,
                  success: true,
                };
              } catch (error: any) {
                console.error('Extraction error:', error);
                console.error(error.message);
                console.error(error.error);
                return {
                  error: `Extraction failed: ${error.message}`,
                  success: false,
                };
              }
            },
          },
          scrape: {
            description:
              'Scrape web pages. Use this to get from a page when you have the url.',
            parameters: z.object({
              url: z.string().describe('URL to scrape'),
            }),
            execute: async ({ url }: { url: string }) => {
              try {
                const scrapeResult = await app.scrapeUrl(url);

                if (!scrapeResult.success) {
                  return {
                    error: `Failed to extract data: ${scrapeResult.error}`,
                    success: false,
                  };
                }

                return {
                  data:
                    scrapeResult.markdown ??
                    'Could get the page content, try using search or extract',
                  success: true,
                };
              } catch (error: any) {
                console.error('Extraction error:', error);
                console.error(error.message);
                console.error(error.error);
                return {
                  error: `Extraction failed: ${error.message}`,
                  success: false,
                };
              }
            },
          },
          deepResearch: {
            description:
              'Perform deep research on a topic using an AI agent that coordinates search, extract, and analysis tools with reasoning steps.',
            parameters: z.object({
              topic: z.string().describe('The topic or question to research'),
            }),
            execute: async ({ topic, maxDepth = 7 }) => {
              const generator = runDeepResearch({
                topic,
                maxDepth,
                reasoningModelId: reasoningModel.apiIdentifier,
                firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',
              });

              while (true) {
                const { value, done } = await generator.next();

                if (done) {
                  const result = value;
                  dataStream.writeData({
                    type: 'finish',
                    content: result.analysis,
                  });
                  return {
                    success: true,
                    data: {
                      findings: result.findings,
                      analysis: result.analysis,
                      completedSteps: result.completedSteps,
                      totalSteps: result.totalSteps,
                    },
                  };
                }

                const event = value;
                switch (event.type) {
                  case 'progress-init':
                    dataStream.writeData({
                      type: 'progress-init',
                      content: { maxDepth: event.maxDepth, totalSteps: event.totalSteps },
                    });
                    break;
                  case 'activity':
                    dataStream.writeData({
                      type: 'activity-delta',
                      content: {
                        type: event.activityType,
                        status: event.status,
                        message: event.message,
                        timestamp: event.timestamp,
                        depth: event.depth,
                        completedSteps: event.completedSteps,
                        totalSteps: event.totalSteps,
                      },
                    });
                    break;
                  case 'source':
                    dataStream.writeData({
                      type: 'source-delta',
                      content: { url: event.url, title: event.title, description: event.description },
                    });
                    break;
                  case 'depth':
                    dataStream.writeData({
                      type: 'depth-delta',
                      content: {
                        current: event.current,
                        max: event.max,
                        completedSteps: event.completedSteps,
                        totalSteps: event.totalSteps,
                      },
                    });
                    break;
                  case 'error': {
                    // After yielding 'error', the generator returns immediately with
                    // partial DeepResearchResult. One more .next() retrieves it.
                    const errorNext = await generator.next();
                    const partial = errorNext.done ? errorNext.value : undefined;
                    return {
                      success: false,
                      error: event.message,
                      data: {
                        findings: partial?.findings ?? [],
                        completedSteps: partial?.completedSteps ?? 0,
                        totalSteps: partial?.totalSteps ?? 0,
                      },
                    };
                  }
                }
              }
            },
          },
        },
        onFinish: async ({ response }) => {
          if (session.user?.id) {
            try {
              const responseMessagesWithoutIncompleteToolCalls =
                sanitizeResponseMessages(response.messages);

              await saveMessages({
                messages: responseMessagesWithoutIncompleteToolCalls.map(
                  (message) => {
                    const messageId = generateUUID();

                    if (message.role === 'assistant') {
                      dataStream.writeMessageAnnotation({
                        messageIdFromServer: messageId,
                      });
                    }

                    return {
                      id: messageId,
                      chatId: id,
                      role: message.role,
                      content: message.content,
                      createdAt: new Date(),
                    };
                  },
                ),
              });
            } catch (error) {
              console.error('Failed to save chat');
            }
          }
        },
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'stream-text',
        },
      });

      result.mergeIntoDataStream(dataStream);
    },
  });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  let session = await auth();

  // If no session exists, create an anonymous session
  if (!session?.user) {
    await signIn('credentials', {
      redirect: false,
    });
    session = await auth();
  }

  if (!session?.user?.id) {
    return new Response('Failed to create session', { status: 500 });
  }

  try {
    const chat = await getChatById({ id });

    if (chat.userId !== session.user.id) {
      return new Response('Unauthorized', { status: 401 });
    }

    await deleteChatById({ id });

    return new Response('Chat deleted', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request', {
      status: 500,
    });
  }
}
