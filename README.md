# scout-xcode

Message queue based transcoding of audio files

## Installing on AWS Ubuntu

This link describes the basic node setup on AWS ubuntu: https://hackernoon.com/tutorial-creating-and-managing-a-node-js-server-on-aws-part-1-d67367ac5171

## Installing ffmpeg

This link has a good description of how to install ffmpeg on both ubuntu and debian AWS instances: https://gist.github.com/jmsaavedra/62bbcd20d40bcddf27ac

## Environment variables

```
AWS_REGION=us-east-1  // Use the same region as the scout-ua server
OPUS_BIT_RATE=24000
POLLY_S3_BUCKET=      // Must match the POLLY_S3_BUCKET value used by the scout-ua server
SQS_QUEUE=            // The full URL of an SQS message queue
SQS_DLQ_ARN=          // The arn (*not* URL) of a second FIFO queue to serve as the dead letter queue
                      // for messages that cannot be processed correctly. Must be the same type (FIFO)
                      // and located in same region as the primary SQS queue
```
