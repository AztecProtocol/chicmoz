import * as k8s from "@kubernetes/client-node";
import { logger } from "../../../logger.js";
import {
  COMPILER_IMAGE,
  EMPTYDIR_SIZE_LIMIT,
  IMAGE_PULL_SECRET,
  JOB_CPU_LIMIT,
  JOB_CPU_REQUEST,
  JOB_MEMORY_LIMIT,
  JOB_MEMORY_REQUEST,
  JOB_TIMEOUT_SECONDS,
  JOB_TTL_AFTER_FINISHED_SECONDS,
  K8S_NAMESPACE,
  L2_NETWORK_ID,
  MAX_CONCURRENT_JOBS,
  READER_POD_IMAGE,
} from "../../../environment.js";
import type { CompileBackend, JobLogs, JobScripts, JobState } from "../backend.js";
import { jobName } from "../naming.js";

let batchApi: k8s.BatchV1Api;
let coreApi: k8s.CoreV1Api;

const initK8sClient = () => {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  batchApi = kc.makeApiClient(k8s.BatchV1Api);
  coreApi = kc.makeApiClient(k8s.CoreV1Api);
};

const LABEL_APP = "source-compiler";
const LABEL_JOB_ID = "chicmoz-job-id";
const LABEL_NETWORK_ID = "chicmoz-l2-network";
const ANNOTATION_CONTRACT_CLASS_ID = "chicmoz/contract-class-id";
const ANNOTATION_VERSION = "chicmoz/version";
const ANNOTATION_GITHUB_URL = "chicmoz/github-url";
const ANNOTATION_AZTEC_VERSION = "chicmoz/aztec-version";
const ANNOTATION_COMPILER_IMAGE = "chicmoz/compiler-image";
const NETWORK_LABEL_VALUE = L2_NETWORK_ID.toLowerCase();

const createCompileJob = async (
  state: JobState,
  scripts: JobScripts,
): Promise<void> => {
  logger.info(
    `Creating compile job: jobId=${state.jobId} backendJobName=${state.backendJobName} contractClassId=${state.contractClassId} version=${state.version} githubUrl=${state.githubUrl} gitRef=${state.gitRef ?? "(default branch)"} subPath=${state.subPath ?? "(repo root)"} aztecVersion=${state.aztecVersion} compilerImage=${state.compilerImage} readerImage=${READER_POD_IMAGE} namespace=${K8S_NAMESPACE}`,
  );

  const { compileScript, readerScript } = scripts;

  const job: k8s.V1Job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: state.backendJobName,
      namespace: K8S_NAMESPACE,
      labels: {
        app: LABEL_APP,
        [LABEL_JOB_ID]: state.jobId,
        [LABEL_NETWORK_ID]: NETWORK_LABEL_VALUE,
      },
      annotations: {
        [ANNOTATION_CONTRACT_CLASS_ID]: state.contractClassId,
        [ANNOTATION_VERSION]: String(state.version),
        [ANNOTATION_GITHUB_URL]: state.githubUrl,
        [ANNOTATION_AZTEC_VERSION]: state.aztecVersion,
        [ANNOTATION_COMPILER_IMAGE]: state.compilerImage,
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: JOB_TIMEOUT_SECONDS,
      ttlSecondsAfterFinished: JOB_TTL_AFTER_FINISHED_SECONDS,
      template: {
        metadata: {
          labels: {
            app: LABEL_APP,
            [LABEL_JOB_ID]: state.jobId,
            [LABEL_NETWORK_ID]: NETWORK_LABEL_VALUE,
          },
        },
        spec: {
          ...(IMAGE_PULL_SECRET
            ? { imagePullSecrets: [{ name: IMAGE_PULL_SECRET }] }
            : {}),
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          initContainers: [
            {
              name: "compiler",
              image: state.compilerImage,
              command: ["/bin/sh", "-c"],
              args: [compileScript],
              env: [
                {
                  name: "NARGO_HOME",
                  value: "/root/nargo",
                },
                {
                  name: "GIT_URL",
                  value: state.githubUrl,
                },
                {
                  name: "AZTEC_VERSION",
                  value: state.aztecVersion,
                },
                ...(state.gitRef
                  ? [{ name: "GIT_REF", value: state.gitRef }]
                  : []),
                ...(state.subPath
                  ? [{ name: "SUB_PATH", value: state.subPath }]
                  : []),
              ],
              volumeMounts: [
                {
                  name: "output",
                  mountPath: "/output",
                },
              ],
              resources: {
                requests: {
                  cpu: JOB_CPU_REQUEST,
                  memory: JOB_MEMORY_REQUEST,
                },
                limits: {
                  cpu: JOB_CPU_LIMIT,
                  memory: JOB_MEMORY_LIMIT,
                },
              },
            },
          ],
          containers: [
            {
              name: "reader",
              image: READER_POD_IMAGE,
              command: ["/bin/sh", "-c"],
              args: [readerScript],
              volumeMounts: [
                {
                  name: "output",
                  mountPath: "/output",
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: "output",
              emptyDir: {
                sizeLimit: EMPTYDIR_SIZE_LIMIT,
              },
            },
          ],
        },
      },
    },
  };

  await batchApi.createNamespacedJob({
    namespace: K8S_NAMESPACE,
    body: job,
  });
  logger.info(`Created K8s Job: ${state.backendJobName}`);
};

const getJobPodName = async (state: JobState): Promise<string> => {
  const pods = await coreApi.listNamespacedPod({
    namespace: K8S_NAMESPACE,
    labelSelector: `${LABEL_JOB_ID}=${state.jobId}`,
  });

  const podName = pods.items[0]?.metadata?.name;
  if (!podName) {
    throw new Error(
      `No pod found for job ${state.backendJobName} (jobId=${state.jobId})`,
    );
  }

  return podName;
};

const readPodContainerLog = async ({
  podName,
  container,
}: {
  podName: string;
  container: string;
}): Promise<string | undefined> => {
  try {
    const logs = await coreApi.readNamespacedPodLog({
      name: podName,
      namespace: K8S_NAMESPACE,
      container,
    });

    return typeof logs === "string" ? logs : String(logs);
  } catch (error) {
    logger.warn(
      `Failed to read ${container} logs for pod ${podName}: ${(error as Error).message}`,
    );
    return undefined;
  }
};

const readJobLogs = async (state: JobState): Promise<JobLogs> => {
  try {
    const podName = await getJobPodName(state);

    const [compileLog, readerLog] = await Promise.all([
      readPodContainerLog({ podName, container: "compiler" }),
      readPodContainerLog({ podName, container: "reader" }),
    ]);

    return { compileLog, readerLog };
  } catch (error) {
    logger.warn(
      `Failed to read job logs for jobId=${state.jobId}: ${(error as Error).message}`,
    );
    return {};
  }
};

const getPodFailureDiagnostics = async (
  state: JobState,
): Promise<string | undefined> => {
  try {
    const podName = await getJobPodName(state);
    const pod = await coreApi.readNamespacedPod({
      name: podName,
      namespace: K8S_NAMESPACE,
    });

    const statusMessages = [
      ...(pod.status?.initContainerStatuses ?? []),
      ...(pod.status?.containerStatuses ?? []),
    ].flatMap((containerStatus) =>
      [
        containerStatus.state?.waiting?.reason,
        containerStatus.state?.waiting?.message,
        containerStatus.state?.terminated?.reason,
        containerStatus.state?.terminated?.message,
        containerStatus.lastState?.terminated?.reason,
        containerStatus.lastState?.terminated?.message,
      ].filter(Boolean),
    );

    const conditionMessages = (pod.status?.conditions ?? []).flatMap(
      (condition) => [condition.reason, condition.message].filter(Boolean),
    );

    const diagnostics = [...statusMessages, ...conditionMessages]
      .join("\n")
      .trim();
    return diagnostics || undefined;
  } catch (error) {
    logger.warn(
      `Failed to read pod diagnostics for jobId=${state.jobId}: ${(error as Error).message}`,
    );
    return undefined;
  }
};

const checkJobStatus = async (
  state: JobState,
): Promise<"running" | "succeeded" | "failed"> => {
  try {
    const job = await batchApi.readNamespacedJob({
      name: state.backendJobName,
      namespace: K8S_NAMESPACE,
    });

    const conditions = job.status?.conditions ?? [];
    for (const cond of conditions) {
      if (cond.type === "Complete" && cond.status === "True") {
        return "succeeded";
      }
      if (cond.type === "Failed" && cond.status === "True") {
        return "failed";
      }
    }
    return "running";
  } catch (e) {
    logger.error(
      `Error checking job status for ${state.backendJobName}: ${(e as Error).message}`,
    );
    return "failed";
  }
};

const getJobFailureReason = async (state: JobState): Promise<string> => {
  try {
    try {
      const podName = await getJobPodName(state);
      const pod = await coreApi.readNamespacedPod({
        name: podName,
        namespace: K8S_NAMESPACE,
      });

      for (const containerStatus of pod.status?.initContainerStatuses ?? []) {
        const waiting = containerStatus.state?.waiting;
        if (waiting) {
          return `${waiting.reason ?? "waiting"}: ${waiting.message ?? ""}`.trim();
        }
      }

      for (const containerStatus of pod.status?.containerStatuses ?? []) {
        const waiting = containerStatus.state?.waiting;
        if (waiting) {
          return `${waiting.reason ?? "waiting"}: ${waiting.message ?? ""}`.trim();
        }
      }
    } catch {
      // Fall back to job conditions below.
    }

    const job = await batchApi.readNamespacedJob({
      name: state.backendJobName,
      namespace: K8S_NAMESPACE,
    });

    const conditions = job.status?.conditions ?? [];
    for (const cond of conditions) {
      if (cond.type === "Failed" && cond.status === "True") {
        if (cond.reason === "DeadlineExceeded") {
          return "timeout";
        }
        return cond.message ?? cond.reason ?? "unknown failure";
      }
    }
    return "unknown failure";
  } catch {
    return "unable to read job status";
  }
};

const recoverActiveJobsFromK8s = async (): Promise<JobState[]> => {
  const recoveredJobs: JobState[] = [];
  logger.info("Recovering active compile jobs from K8s...");

  try {
    const jobList = await batchApi.listNamespacedJob({
      namespace: K8S_NAMESPACE,
      labelSelector: `app=${LABEL_APP},${LABEL_NETWORK_ID}=${NETWORK_LABEL_VALUE}`,
    });

    let recovered = 0;
    for (const job of jobList.items) {
      const jobId = job.metadata?.labels?.[LABEL_JOB_ID];
      if (!jobId) {
        continue;
      }

      // Check if the job is still active (no Complete or Failed condition)
      const conditions = job.status?.conditions ?? [];
      const isFinished = conditions.some(
        (c: k8s.V1JobCondition) =>
          (c.type === "Complete" || c.type === "Failed") && c.status === "True",
      );

      if (!isFinished) {
        const annotations = job.metadata?.annotations ?? {};
        const state: JobState = {
          jobId,
          backendJobName: job.metadata?.name ?? jobName(jobId),
          contractClassId:
            annotations[ANNOTATION_CONTRACT_CLASS_ID] ?? "unknown-recovery",
          version: Number(annotations[ANNOTATION_VERSION]) || 0,
          githubUrl: annotations[ANNOTATION_GITHUB_URL] ?? "unknown-recovery",
          aztecVersion:
            annotations[ANNOTATION_AZTEC_VERSION] ?? "unknown-recovery",
          compilerImage:
            annotations[ANNOTATION_COMPILER_IMAGE] ?? COMPILER_IMAGE,
          createdAt: job.metadata?.creationTimestamp
            ? new Date(job.metadata.creationTimestamp)
            : new Date(),
        };
        recoveredJobs.push(state);
        recovered++;
        logger.info(
          `Recovered active job: ${state.backendJobName} (jobId=${jobId})`,
        );
      }
    }

    logger.info(`Recovery complete. ${recovered} active jobs found.`);
  } catch (e) {
    logger.error(`Failed to recover active jobs: ${(e as Error).message}`);
  }
  return recoveredJobs;
};


export const createK8sBackend = (): CompileBackend => ({
  name: "k8s",
  init: () => {
    initK8sClient();
    logger.info("K8s client initialized");
    return Promise.resolve();
  },
  launch: (state: JobState, scripts: JobScripts) =>
    createCompileJob(state, scripts),
  checkStatus: (state: JobState) => checkJobStatus(state),
  readLogs: async (state: JobState): Promise<JobLogs> => {
    const logs = await readJobLogs(state);
    const diagnostics = await getPodFailureDiagnostics(state);
    return { ...logs, diagnostics };
  },
  getFailureReason: (state: JobState) => getJobFailureReason(state),
  recoverActiveJobs: () => recoverActiveJobsFromK8s(),
  getConfigStr: () =>
    `K8S_NAMESPACE=${K8S_NAMESPACE} MAX_CONCURRENT=${MAX_CONCURRENT_JOBS} COMPILER_IMAGE=${COMPILER_IMAGE}`,
});
