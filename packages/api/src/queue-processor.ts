/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-misused-promises */
import {
  ConnectionOptions,
  Job,
  JobState,
  JobType,
  Queue,
  QueueEvents,
  Worker,
} from 'bullmq'
import express, { Express } from 'express'
import { appDataSource } from './data_source'
import { env } from './env'
import { TaskState } from './generated/graphql'
import { aiSummarize, AI_SUMMARIZE_JOB_NAME } from './jobs/ai-summarize'
import { createDigestJob, CREATE_DIGEST_JOB } from './jobs/ai/create_digest'
import { bulkAction, BULK_ACTION_JOB_NAME } from './jobs/bulk_action'
import { callWebhook, CALL_WEBHOOK_JOB_NAME } from './jobs/call_webhook'
import { findThumbnail, THUMBNAIL_JOB } from './jobs/find_thumbnail'
import {
  exportAllItems,
  EXPORT_ALL_ITEMS_JOB_NAME,
} from './jobs/integration/export_all_items'
import {
  exportItem,
  EXPORT_ITEM_JOB_NAME,
} from './jobs/integration/export_item'
import {
  processYouTubeTranscript,
  processYouTubeVideo,
  PROCESS_YOUTUBE_TRANSCRIPT_JOB_NAME,
  PROCESS_YOUTUBE_VIDEO_JOB_NAME,
} from './jobs/process-youtube-video'
import { refreshAllFeeds } from './jobs/rss/refreshAllFeeds'
import { refreshFeed } from './jobs/rss/refreshFeed'
import { savePageJob } from './jobs/save_page'
import { sendEmailJob, SEND_EMAIL_JOB } from './jobs/email/send_email'
import {
  syncReadPositionsJob,
  SYNC_READ_POSITIONS_JOB_NAME,
} from './jobs/sync_read_positions'
import { triggerRule, TRIGGER_RULE_JOB_NAME } from './jobs/trigger_rule'
import {
  updateHighlight,
  updateLabels,
  UPDATE_HIGHLIGHT_JOB,
  UPDATE_LABELS_JOB,
} from './jobs/update_db'
import { updatePDFContentJob } from './jobs/update_pdf_content'
import { redisDataSource } from './redis_data_source'
import { CACHED_READING_POSITION_PREFIX } from './services/cached_reading_position'
import { getJobPriority } from './utils/createTask'
import { logger } from './utils/logger'
import {
  confirmEmailJob,
  CONFIRM_EMAIL_JOB,
  forwardEmailJob,
  FORWARD_EMAIL_JOB,
  saveAttachmentJob,
  saveNewsletterJob,
  SAVE_ATTACHMENT_JOB,
  SAVE_NEWSLETTER_JOB,
} from './jobs/email/inbound_emails'

export const QUEUE_NAME = 'omnivore-backend-queue'
export const JOB_VERSION = 'v001'

export const getBackendQueue = async (
  name = QUEUE_NAME
): Promise<Queue | undefined> => {
  if (!redisDataSource.workerRedisClient) {
    throw new Error('Can not create queues, redis is not initialized')
  }

  const backendQueue = new Queue(name, {
    connection: redisDataSource.workerRedisClient,
    defaultJobOptions: {
      backoff: {
        type: 'exponential',
        delay: 2000, // 2 seconds
      },
      removeOnComplete: {
        age: 24 * 3600, // keep up to 24 hours
      },
      removeOnFail: {
        age: 7 * 24 * 3600, // keep up to 7 days
      },
    },
  })
  await backendQueue.waitUntilReady()
  return backendQueue
}

export const createJobId = (jobName: string, userId: string) =>
  `${jobName}_${userId}_${JOB_VERSION}`

export const getJob = async (jobId: string, queueName?: string) => {
  const queue = await getBackendQueue(queueName)
  if (!queue) {
    return
  }
  return queue.getJob(jobId)
}

export const jobStateToTaskState = (
  jobState: JobState | 'unknown'
): TaskState => {
  switch (jobState) {
    case 'completed':
      return TaskState.Succeeded
    case 'failed':
      return TaskState.Failed
    case 'active':
      return TaskState.Running
    case 'delayed':
      return TaskState.Pending
    case 'waiting':
      return TaskState.Pending
    default:
      return TaskState.Pending
  }
}

export const createWorker = (connection: ConnectionOptions) =>
  new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case 'refresh-all-feeds': {
          const queue = await getBackendQueue()
          const counts = await queue?.getJobCounts('prioritized')
          if (counts && counts.wait > 1000) {
            return
          }
          return await refreshAllFeeds(appDataSource)
        }
        case 'refresh-feed': {
          return await refreshFeed(job.data)
        }
        case 'save-page': {
          return savePageJob(job.data, job.attemptsMade)
        }
        case 'update-pdf-content': {
          return updatePDFContentJob(job.data)
        }
        case THUMBNAIL_JOB:
          return findThumbnail(job.data)
        case TRIGGER_RULE_JOB_NAME:
          return triggerRule(job.data)
        case UPDATE_LABELS_JOB:
          return updateLabels(job.data)
        case UPDATE_HIGHLIGHT_JOB:
          return updateHighlight(job.data)
        case SYNC_READ_POSITIONS_JOB_NAME:
          return syncReadPositionsJob(job.data)
        case BULK_ACTION_JOB_NAME:
          return bulkAction(job.data)
        case CALL_WEBHOOK_JOB_NAME:
          return callWebhook(job.data)
        case EXPORT_ITEM_JOB_NAME:
          return exportItem(job.data)
        case AI_SUMMARIZE_JOB_NAME:
          return aiSummarize(job.data)
        case PROCESS_YOUTUBE_VIDEO_JOB_NAME:
          return processYouTubeVideo(job.data)
        case PROCESS_YOUTUBE_TRANSCRIPT_JOB_NAME:
          return processYouTubeTranscript(job.data)
        case EXPORT_ALL_ITEMS_JOB_NAME:
          return exportAllItems(job.data)
        case SEND_EMAIL_JOB:
          return sendEmailJob(job.data)
        case CONFIRM_EMAIL_JOB:
          return confirmEmailJob(job.data)
        case SAVE_ATTACHMENT_JOB:
          return saveAttachmentJob(job.data)
        case SAVE_NEWSLETTER_JOB:
          return saveNewsletterJob(job.data)
        case FORWARD_EMAIL_JOB:
          return forwardEmailJob(job.data)
        case CREATE_DIGEST_JOB:
          return createDigestJob(job.data)
        default:
          logger.warning(`[queue-processor] unhandled job: ${job.name}`)
      }
    },
    {
      connection,
    }
  )

const setupCronJobs = async () => {
  const queue = await getBackendQueue()
  if (!queue) {
    logger.error('Unable to setup cron jobs. Queue is not available.')
    return
  }

  await queue.add(
    SYNC_READ_POSITIONS_JOB_NAME,
    {},
    {
      priority: getJobPriority(SYNC_READ_POSITIONS_JOB_NAME),
      repeat: {
        every: 60_000,
      },
    }
  )
}

const main = async () => {
  console.log('[queue-processor]: starting queue processor')

  const app: Express = express()
  const port = process.env.PORT || 3002

  redisDataSource.setOptions({
    cache: env.redis.cache,
    mq: env.redis.mq,
  })

  // respond healthy to auto-scaler.
  app.get('/_ah/health', (req, res) => res.sendStatus(200))

  app.get('/lifecycle/prestop', async (req, res) => {
    logger.info('prestop lifecycle hook called.')
    await worker.close()
    res.sendStatus(200)
  })

  app.get('/metrics', async (_, res) => {
    const queue = await getBackendQueue()
    if (!queue) {
      res.sendStatus(400)
      return
    }

    let output = ''
    const metrics: JobType[] = ['active', 'failed', 'completed', 'prioritized']
    const counts = await queue.getJobCounts(...metrics)

    metrics.forEach((metric, idx) => {
      output += `# TYPE omnivore_queue_messages_${metric} gauge\n`
      output += `omnivore_queue_messages_${metric}{queue="${QUEUE_NAME}"} ${counts[metric]}\n`
    })

    if (redisDataSource.redisClient) {
      // Add read-position count, if its more than 10K items just denote
      // 10_001. As this should never occur and means there is some
      // other serious issue occurring.
      const [cursor, batch] = await redisDataSource.redisClient.scan(
        0,
        'MATCH',
        `${CACHED_READING_POSITION_PREFIX}:*`,
        'COUNT',
        10_000
      )
      if (cursor != '0') {
        output += `# TYPE omnivore_read_position_messages gauge\n`
        output += `omnivore_read_position_messages{queue="${QUEUE_NAME}"} ${10_001}\n`
      } else if (batch) {
        output += `# TYPE omnivore_read_position_messages gauge\n`
        output += `omnivore_read_position_messages{} ${batch.length}\n`
      }
    }

    // Export the age of the oldest prioritized job in the queue
    const oldestJobs = await queue.getJobs(['prioritized'], 0, 1, true)
    if (oldestJobs.length > 0) {
      const currentTime = Date.now()
      const ageInSeconds = (currentTime - oldestJobs[0].timestamp) / 1000
      output += `# TYPE omnivore_queue_messages_oldest_job_age_seconds gauge\n`
      output += `omnivore_queue_messages_oldest_job_age_seconds{queue="${QUEUE_NAME}"} ${ageInSeconds}\n`
    } else {
      output += `# TYPE omnivore_queue_messages_oldest_job_age_seconds gauge\n`
      output += `omnivore_queue_messages_oldest_job_age_seconds{queue="${QUEUE_NAME}"} ${0}\n`
    }

    res.status(200).setHeader('Content-Type', 'text/plain').send(output)
  })

  const server = app.listen(port, () => {
    console.log(`[queue-processor]: started`)
  })

  // This is done after all the setup so it can access the
  // environment that was loaded from GCP
  await appDataSource.initialize()
  await redisDataSource.initialize()

  const redisClient = redisDataSource.redisClient
  const workerRedisClient = redisDataSource.workerRedisClient
  if (!workerRedisClient || !redisClient) {
    throw '[queue-processor] error redis is not initialized'
  }

  const worker = createWorker(workerRedisClient)

  await setupCronJobs()

  const queueEvents = new QueueEvents(QUEUE_NAME, {
    connection: workerRedisClient,
  })

  queueEvents.on('added', async (job) => {
    console.log('added job: ', job.jobId, job.name)
  })

  queueEvents.on('removed', async (job) => {
    console.log('removed job: ', job.jobId)
  })

  queueEvents.on('completed', async (job) => {
    console.log('completed job: ', job.jobId)
  })

  workerRedisClient.on('error', (error) => {
    console.trace('[queue-processor]: redis worker error', { error })
  })

  redisClient.on('error', (error) => {
    console.trace('[queue-processor]: redis error', { error })
  })

  const gracefulShutdown = async (signal: string) => {
    console.log(`[queue-processor]: Received ${signal}, closing server...`)
    await new Promise<void>((resolve) => {
      server.close((err) => {
        console.log('[queue-processor]: Express server closed')
        if (err) {
          console.log('[queue-processor]: error stopping server', { err })
        }

        resolve()
      })
    })
    await worker.close()
    await redisDataSource.shutdown()
    await appDataSource.destroy()
    process.exit(0)
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

  process.on('uncaughtException', function (err) {
    // Handle the error safely
    logger.error('Uncaught exception', err)
  })

  process.on('unhandledRejection', (reason, promise) => {
    // Handle the error safely
    logger.error('Unhandled Rejection at: Promise', { promise, reason })
  })
}

// only call main if the file was called from the CLI and wasn't required from another module
if (require.main === module) {
  main().catch((e) => console.error(e))
}
