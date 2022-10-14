import { EventBusService, TransactionBaseService } from '@medusajs/medusa';
import axios from 'axios';
import formatRegistrationName from '@medusajs/medusa/dist/utils/format-registration-name';
import { EntityManager } from 'typeorm';

import { SentryOptions, SentryWebHookData, SentryWebHookEvent } from '../types';
import { isFunction } from '../utils';

type InjectedDeps = {
	manager: EntityManager;
	eventBusService: EventBusService;
};

type SentryFetchResult = {
	data: Record<string, string>[];
	meta: unknown;
	prev_cursor: string;
	next_cursor: string;
};

export default class SentryService extends TransactionBaseService {
	static readonly RESOLVE_KEY = formatRegistrationName(`${process.cwd()}/services/sentry.js`);
	protected readonly sentryApiBaseUrl = 'https://sentry.io/api/0/organizations';

	protected manager_: EntityManager;
	protected transactionManager_: EntityManager | undefined;

	protected readonly config_: SentryOptions;
	protected readonly eventBusService_: EventBusService;

	constructor({ manager, eventBusService }: InjectedDeps, config: SentryOptions) {
		// @ts-ignore
		super(...arguments);

		this.manager_ = manager;
		this.config_ = config;
		this.eventBusService_ = eventBusService;
	}

	/**
	 * Fetch paginated transactions from an organisation project on sentry
	 * @param organisation The organisation on which to fetch the transactions
	 * @param project The project in the organisation on which to fetch the transactions
	 * @param query Equation to filter the result (https://docs.sentry.io/product/sentry-basics/search/)
	 * @param statsPeriod The period from when to fetch the transactions (default: 24h)
	 * @param perPage The number of transaction per page
	 * @param token The token to use to send request to sentry
	 * @param cursor The cursor to send to fetch the transactions for a given page
	 * @return The result is composed of the data and the next cursor for the pagination purpose
	 */
	async fetchTransactions({
		organisation,
		project,
		query,
		statsPeriod,
		perPage,
		token,
		cursor,
	}): Promise<SentryFetchResult> {
		perPage = perPage ?? 100;

		const queryParams = {
			field: ['transaction', 'tpm()', 'p50()', 'p75()', 'p95()', 'failure_rate', 'apdex()'],
			per_page: Number(perPage),
			project,
			query: `event.type:transaction${query ? ' AND ' + query : ''}`,
			statsPeriod,
			sort: '-transaction',
			// The three values from cursor are: cursor identifier (integer, usually 0), row offset, and is_prev (1 or 0).
			// e.g 0:10:0
			cursor,
		};

		return await this.fetchSentry({
			organisation,
			token,
			perPage,
			queryParams,
		});
	}

	/**
	 * Fetch paginated transaction events from an organisation project on sentry
	 * @param transaction The transaction for which to fetch the events (e.g "GET /admin/users")
	 * @param organisation The organisation on which to fetch the transactions
	 * @param project The project in the organisation on which to fetch the transactions
	 * @param query Equation to filter the result (https://docs.sentry.io/product/sentry-basics/search/)
	 * @param statsPeriod The period from when to fetch the transactions (default: 24h)
	 * @param perPage The number of transaction per page
	 * @param token The token to use to send request to sentry
	 * @param cursor The cursor to send to fetch the transactions for a given page
	 * @return The result is composed of the data and the next cursor for the pagination purpose
	 */
	async fetchTransactionEvents({
		transaction,
		organisation,
		project,
		query,
		statsPeriod,
		perPage,
		token,
		cursor,
	}): Promise<SentryFetchResult> {
		perPage = perPage ?? 100;

		const queryParams = {
			field: ['id', 'transaction.duration', 'timestamp', 'spans.db', 'project'],
			per_page: Number(perPage),
			project,
			query: `event.type:transaction AND transaction:"${transaction}"${query ? ' AND ' + query : ''}`,
			statsPeriod,
			sort: '-timestamp',
			// The three values from cursor are: cursor identifier (integer, usually 0), row offset, and is_prev (1 or 0).
			// e.g 0:10:0
			cursor,
		};

		return await this.fetchSentry({
			organisation,
			token,
			perPage,
			queryParams,
		});
	}

	async handleIssues(data: SentryWebHookData): Promise<void> {
		await this.manager_.transaction(async (transactionManager) => {
			if (isFunction(this.config_.webHookOptions.emitOnIssue)) {
				return await this.config_.webHookOptions.emitOnIssue(this.__container__, data);
			}
			await this.eventBusService_
				.withTransaction(transactionManager)
				.emit(SentryWebHookEvent.SENTRY_RECEIVED_ISSUE, data);
		});
	}

	async handleErrors(data: SentryWebHookData): Promise<void> {
		await this.manager_.transaction(async (transactionManager) => {
			if (isFunction(this.config_.webHookOptions.emitOnError)) {
				return await this.config_.webHookOptions.emitOnError(this.__container__, data);
			}
			await this.eventBusService_
				.withTransaction(transactionManager)
				.emit(SentryWebHookEvent.SENTRY_RECEIVED_ERROR, data);
		});
	}

	async handleComments(data: SentryWebHookData): Promise<void> {
		await this.manager_.transaction(async (transactionManager) => {
			if (isFunction(this.config_.webHookOptions.emitOnComment)) {
				return await this.config_.webHookOptions.emitOnComment(this.__container__, data);
			}
			await this.eventBusService_
				.withTransaction(transactionManager)
				.emit(SentryWebHookEvent.SENTRY_RECEIVED_COMMENT, data);
		});
	}

	async handleAlerts(data: SentryWebHookData): Promise<void> {
		await this.manager_.transaction(async (transactionManager) => {
			if (isFunction(this.config_.webHookOptions.emitOnEventOrMetricAlert)) {
				return await this.config_.webHookOptions.emitOnEventOrMetricAlert(this.__container__, data);
			}
			await this.eventBusService_
				.withTransaction(transactionManager)
				.emit(SentryWebHookEvent.SENTRY_RECEIVED_EVENT_OR_METRIC_ALERT, data);
		});
	}

	async handleInstallation(data: SentryWebHookData): Promise<void> {
		await this.manager_.transaction(async (transactionManager) => {
			if (isFunction(this.config_.webHookOptions.emitOnInstallOrDeleted)) {
				return await this.config_.webHookOptions.emitOnInstallOrDeleted(this.__container__, data);
			}
			await this.eventBusService_
				.withTransaction(transactionManager)
				.emit(SentryWebHookEvent.SENTRY_RECEIVED_INSTALL_OR_DELETED, data);
		});
	}

	protected async fetchSentry({ organisation, token, queryParams, perPage }): Promise<SentryFetchResult> {
		const url = this.sentryApiBaseUrl + `/${organisation}/events/`;

		const searchParams = new URLSearchParams();
		Object.entries(queryParams).forEach(([key, value]) => {
			if (Array.isArray(value)) {
				value.forEach((val) => {
					searchParams.append(key, val);
				});
			} else {
				value && searchParams.append(key, value?.toString());
			}
		});

		const {
			data: { data, meta },
			headers,
		} = await axios.get(url, {
			headers: {
				Authorization: `Bearer ${token}`,
			},
			params: searchParams,
		});

		const nextCursor = SentryService.buildNextCursor(headers['link']);
		const currentCursor = SentryService.buildCurrentCursor(headers['link'], perPage);

		let prevCursor: string;
		if (currentCursor) {
			prevCursor = SentryService.buildPrevCursor(currentCursor, perPage);
		}

		return { data, meta, prev_cursor: prevCursor, next_cursor: nextCursor };
	}

	protected static buildNextCursor(link: string): string | undefined {
		let result;

		const nextCursorMatch = link?.match(/.*cursor="(.*)"$/);
		const hasResults = link?.match(/.*results="(.*)";/);
		if (hasResults && hasResults[1] === 'true') {
			if (nextCursorMatch && nextCursorMatch[1]) {
				result = nextCursorMatch[1]?.split(',')[0];
			}
		}

		return result;
	}

	protected static buildCurrentCursor(link: string, perPage: number): string | undefined {
		let result;

		const nextCursorMatch = link?.match(/.*cursor="(.*)"$/);
		if (nextCursorMatch && nextCursorMatch[1]) {
			result = nextCursorMatch[1]?.split(',')[0];
		}

		return this.buildPrevCursor(result, perPage);
	}

	protected static buildPrevCursor(nextCursor: string, perPage: number): string | undefined {
		const parts = nextCursor.split(':');
		const prevCursorItems = Number(parts[1]) - perPage;
		if (prevCursorItems < 0) {
			return;
		}
		return `${parts[0]}:${prevCursorItems}:${parts[2]}`;
	}
}
