import { and, eq, getTableName, inArray, isNull, isSQLWrapper } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core/columns";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core/query-builders/update";
import type { SQL } from "drizzle-orm/sql/sql";
import type { ValueOrArray } from "drizzle-orm/utils";

import type { DrizzleDb } from "~/drizzle/DrizzleDb";
import type { DrizzleEntityNamePK, DrizzleSchema, DrizzleTable } from "~/drizzle/DrizzleSchema";

// This file redefines some types from our schema such that the generic type param is the table type itself,
// rather than the table name.
type DrizzleEntity<T extends DrizzleTablePK = DrizzleTablePK> = T["$inferSelect"];

type DrizzleTablePK = DrizzleSchema[DrizzleEntityNamePK];

interface IBatch {
	ids: string[];
	promise: Promise<DrizzleEntity[]>;
}

type Where<T> = ((aliases: T) => SQL | undefined) | SQL | undefined;

type OrderBy<T> = (aliases: T) => ValueOrArray<PgColumn | SQL | SQL.Aliased>;

interface IFindOpts<TTable extends DrizzleTablePK> {
	where?: Where<TTable>;
	orderBy?: OrderBy<TTable>;
	limit?: number;
}

export class EntityLoader {
	/**
	 * @param drizzle - The drizzle database instance to use for fetching entities.
	 */
	constructor(public drizzle: DrizzleDb) {}

	private batch = new Map<string, IBatch>();
	private cache = new Map<string, DrizzleEntity>();

	/**
	 * Returns all entities, optionally matching the `where` condition.
	 *
	 * Further filtering can be applied using the `orderBy` and `limit` options.

	 * @param table - The drizzle table configuration.
	 * @param opts - The options to apply to the query. Optional.
	 */
	async find<TTable extends DrizzleTablePK>(
		table: TTable,
		opts: IFindOpts<TTable> | Where<TTable> = {}
	): Promise<DrizzleEntity<TTable>[]> {
		const pk = primaryKey(table);

		let q;
		q = this.drizzle.select().from(table);

		const conditions: (SQL | undefined)[] = [];

		if ("metadataDeletedAt" in table) {
			conditions.push(isNull(table.metadataDeletedAt));
		}

		// If `opts` is SQL or a function, it is assumed to be a `where` condition
		if (isSQLWrapper(opts)) {
			conditions.push(opts);
		} else if (typeof opts === "function") {
			conditions.push(opts(table));
		} else if (isSQLWrapper(opts.where)) {
			conditions.push(opts.where);
		} else if (typeof opts.where === "function") {
			conditions.push(opts.where(table));
		}

		if (conditions.length > 0) {
			// drizzle is ok with passing a single argument to `and`
			q = q.where(and(...conditions));
		}

		const { orderBy, limit } = opts as IFindOpts<TTable>;

		if (orderBy) {
			const expr = orderBy(table);
			q = Array.isArray(expr) ? q.orderBy(...expr) : q.orderBy(expr);
		}

		if (typeof limit === "number") {
			q = q.limit(limit);
		}

		const entities = (await q) as DrizzleEntity<TTable>[];
		for (const entity of entities) this.cache.set(entity[pk] as string, entity);

		return entities;
	}

	/**
	 * Returns the entity with given `id`, or `undefined` if the entity cannot be found.
	 *
	 * @param table - The entity type (constructor)
	 * @param id - The id of the entity to fetch.
	 */
	async findOne<TTable extends DrizzleTablePK>(
		table: TTable,
		id: string
	): Promise<DrizzleEntity<TTable> | undefined> {
		const pk = primaryKey(table);
		const tableName = getTableName(table);
		let batch = this.batch.get(tableName);

		if (!batch) {
			batch = {
				ids: [],
				promise: new Promise<string[]>((resolve) => {
					setTimeout(() => {
						this.batch.delete(tableName);
						resolve((batch as IBatch).ids);
					}, 0);
				}).then((ids) =>
					ids.length === 0 ? [] : this.find(table, (e) => inArray(e[pk] as PgColumn, ids))
				),
			};
			this.batch.set(tableName, batch);
		}

		let entity = this.cache.get(id); //as DrizzleEntity<TEntityName> | undefined;
		// Entity has not been fetched before, so fetch it in the next batch
		if (!entity) {
			batch.ids.push(id);
			await batch.promise;

			entity = this.cache.get(id);
		} else {
			// Always await the batch in order to gather as many requests as possible in the next batch
			await batch.promise;
		}

		// QUICKFIX: Remove the `search` field from the entity to allow it to be inserted again
		// This is a workaround since the `search` field is generated by Postgres and cannot be easily
		// updated
		if (entity && "search" in entity) {
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-ignore
			delete entity.search;
		}

		return entity;
	}

	/**
	 * Returns the entity with given `id`.
	 *
	 * An error is thrown when the entity cannot be found.
	 *
	 * @param table - The entity type name
	 * @param id - The id of the entity to fetch.
	 */
	one<TTable extends DrizzleTablePK>(table: TTable, id: string): Promise<DrizzleEntity<TTable>>;

	/**
	 * Fetches the entity with given `id` and returns the entity's `propertyName` field.
	 *
	 * @param table - The entity type name
	 * @param id - The id of the entity to fetch.
	 * @param property - The property of the fetched entity to return.
	 */
	one<TTable extends DrizzleTablePK, TProperty extends keyof DrizzleEntity<TTable>>(
		table: TTable,
		id: string,
		property: TProperty
	): Promise<DrizzleEntity<TTable>[TProperty]>;
	async one<TTable extends DrizzleTablePK, TProperty extends keyof DrizzleEntity<TTable>>(
		name: TTable,
		id: string,
		property?: TProperty
	): Promise<DrizzleEntity<TTable> | DrizzleEntity<TTable>[TProperty]> {
		const entity = await this.findOne(name, id);

		if (!entity) {
			throw new Error(`Entity not found (id = ${id})`);
		}

		if (property != undefined) return entity[property];

		return entity;
	}

	insert<TTable extends DrizzleTable>(
		table: TTable,
		entity: TTable["$inferInsert"]
	): Promise<unknown> {
		return this.drizzle.insert(table).values(entity).execute();
	}

	async update<TTable extends DrizzleTablePK>(
		table: TTable,
		id: string,
		entity: PgUpdateSetSource<TTable>
	) {
		const pk = primaryKey(table);
		const result = await this.drizzle
			.update(table)
			.set(entity)
			.where(eq(table[pk] as PgColumn, id))
			.returning({ id: table[pk] as PgColumn })
			.execute();

		return result.length;
	}
}

/**
 * Returns the name of the primary key of the given table.
 *
 * If the table has a column named `id`, that column is assumed to be the primary key. Otherwise, the columns are
 * searched for a column with the `primary` flag set to `true`. If no such column is found, an error is thrown.
 * An error is also thrown if the table has more than one primary key column.
 *
 * @param table - The table to get the primary key of.
 */
function primaryKey<TTable extends DrizzleTablePK>(
	table: TTable
): keyof TTable & keyof DrizzleEntity<TTable> {
	if ("id" in table) {
		return "id" as keyof TTable & keyof DrizzleEntity<TTable>;
	}

	const pk: string[] = [];

	for (const [c, def] of Object.entries(table)) {
		if ((def as PgColumn).primary) pk.push(c);
	}

	if (pk.length === 0) {
		throw new Error(
			`EntityLoader: Table without primary key not supported (${getTableName(table)})`
		);
	}

	if (pk.length > 1) {
		throw new Error(`EntityLoader: Composite primary key not supported (${getTableName(table)})`);
	}
	return pk[0] as keyof TTable & keyof DrizzleEntity<TTable>;
}