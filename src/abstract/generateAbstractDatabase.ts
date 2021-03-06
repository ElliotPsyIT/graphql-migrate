import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLField,
  GraphQLOutputType,
  isObjectType,
  isScalarType,
  isEnumType,
  isListType,
  isNonNullType,
  GraphQLScalarType,
} from 'graphql'
import { TypeMap } from 'graphql/type/schema'
import { AbstractDatabase } from './AbstractDatabase'
import { Table } from './Table'
import { TableColumn, ForeignKey } from './TableColumn'
import { parseAnnotations, stripAnnotations } from 'graphql-annotations'
import getColumnTypeFromScalar, { TableColumnTypeDescriptor } from './getColumnTypeFromScalar'
import { escapeComment } from '../util/comments'

const ROOT_TYPES = ['Query', 'Mutation', 'Subscription']

const INDEX_TYPES = [
  {
    annotation: 'index',
    list: 'indexes',
    hasType: true,
    defaultName: (table: string, column: string) => `${table}_${column}_index`,
  },
  {
    annotation: 'primary',
    list: 'primaries',
    default: (name: string, type: string) => name === 'id' && type === 'ID',
    max: 1,
    defaultName: (table: string) => `${table}_pkey`,
  },
  {
    annotation: 'unique',
    list: 'uniques',
    defaultName: (table: string, column: string) => `${table}_${column}_unique`,
  },
]

export type ScalarMap = (
  field: GraphQLField<any, any>,
  scalarType: GraphQLScalarType | null,
  annotations: any,
) => TableColumnTypeDescriptor | null

export interface GenerateAbstractDatabaseOptions {
  lowercaseNames?: boolean
  scalarMap?: ScalarMap | null
  mapListToJson?: boolean
}

export const defaultOptions: GenerateAbstractDatabaseOptions = {
  lowercaseNames: true,
  scalarMap: null,
}

export default async function (
  schema: GraphQLSchema,
  options: GenerateAbstractDatabaseOptions = defaultOptions,
): Promise<AbstractDatabase> {
  const builder = new AbstractDatabaseBuilder(schema, options)
  return builder.build()
}

class AbstractDatabaseBuilder {
  private schema: GraphQLSchema
  private lowercaseNames: boolean
  private scalarMap: ScalarMap | null
  private mapListToJson: boolean
  private typeMap: TypeMap
  private database: AbstractDatabase
  /** Used to push new intermediary tables after current table */
  private tableQueue: Table[] = []
  private currentTable: Table | null = null
  private currentType: string | null = null

  constructor (schema: GraphQLSchema, options: GenerateAbstractDatabaseOptions) {
    this.schema = schema
    this.lowercaseNames = options.lowercaseNames || defaultOptions.lowercaseNames as boolean
    this.scalarMap = options.scalarMap as ScalarMap | null
    this.mapListToJson = options.mapListToJson || defaultOptions.mapListToJson as boolean
    this.typeMap = this.schema.getTypeMap()

    this.database = {
      tables: [],
      tableMap: new Map(),
    }
  }

  public build (): AbstractDatabase {
    for (const key in this.typeMap) {
      const type = this.typeMap[key]
      // Tables
      if (isObjectType(type) && !type.name.startsWith('__') && !ROOT_TYPES.includes(type.name)) {
        this.buildTable(type)
      }
    }
    this.database.tables.push(...this.tableQueue)
    this.fillForeignKeys()
    return this.database
  }

  private getName (name: string) {
    if (this.lowercaseNames) { return name.toLowerCase() }
    return name
  }

  private buildTable (type: GraphQLObjectType) {
    const annotations: any = parseAnnotations('db', type.description || null)

    if (annotations.skip) {
      return
    }

    const table: Table = {
      name: annotations.name || this.getName(type.name),
      comment: escapeComment(stripAnnotations(type.description || null)),
      annotations,
      columns: [],
      columnMap: new Map<string, TableColumn>(),
      indexes: [],
      primaries: [],
      uniques: [],
    }

    this.currentTable = table
    this.currentType = type.name

    const fields = type.getFields()
    for (const key in fields) {
      const field = fields[key]
      this.buildColumn(table, field)
    }

    this.currentTable = null
    this.currentType = null

    this.database.tables.push(table)
    this.database.tableMap.set(type.name, table)

    return table
  }

  private buildColumn (table: Table, field: GraphQLField<any, any>) {
    const descriptor = this.getFieldDescriptor(field)
    if (!descriptor) { return }
    table.columns.push(descriptor)
    table.columnMap.set(field.name, descriptor)
    return descriptor
  }

  private getFieldDescriptor (
    field: GraphQLField<any, any>,
    fieldType: GraphQLOutputType | null = null,
  ): TableColumn | null {
    const annotations: any = parseAnnotations('db', field.description || null)

    if (annotations.skip) {
      return null
    }

    if (!fieldType) {
      fieldType = isNonNullType(field.type) ? field.type.ofType : field.type
    }

    const notNull = isNonNullType(field.type)
    let columnName: string = annotations.name || this.getName(field.name)
    let type: string
    let args: any[]
    let foreign: ForeignKey | null = null

    // Scalar
    if (isScalarType(fieldType) || annotations.type) {
      let descriptor
      if (this.scalarMap) {
        descriptor = this.scalarMap(field, isScalarType(fieldType) ? fieldType : null, annotations)
      }
      if (!descriptor) {
        descriptor = getColumnTypeFromScalar(field, isScalarType(fieldType) ? fieldType : null, annotations)
      }
      if (!descriptor) {
        console.warn(`Unsupported type ${fieldType} on field ${this.currentType}.${field.name}.`)
        return null
      }
      type = descriptor.type
      args = descriptor.args

    // Enum
    } else if (isEnumType(fieldType)) {
      type = 'enum'
      args = [fieldType.getValues().map((v) => v.name), { enumName: annotations.enumName || this.getName(fieldType.name) }]

    // Object
    } else if (isObjectType(fieldType)) {
      columnName = annotations.name || this.getName(`${field.name}_foreign`)
      const foreignType = this.typeMap[fieldType.name]
      if (!foreignType) {
        console.warn(`Foreign type ${fieldType.name} not found on field ${this.currentType}.${field.name}.`)
        return null
      }
      if (!isObjectType(foreignType)) {
        console.warn(`Foreign type ${fieldType.name} is not Object type on field ${this.currentType}.${field.name}.`)
        return null
      }
      const foreignKey: string = annotations.foreign || 'id'
      const foreignField = foreignType.getFields()[foreignKey]
      if (!foreignField) {
        console.warn(`Foreign field ${foreignKey} on type ${fieldType.name} not found on field ${field.name}.`)
        return null
      }
      const descriptor = this.getFieldDescriptor(foreignField)
      if (!descriptor) {
        console.warn(`Couldn't create foreign field ${foreignKey} on type ${fieldType.name} on field ${field.name}. See above messages.`)
        return null
      }
      type = descriptor.type
      args = descriptor.args
      foreign = {
        type: foreignType.name,
        field: foreignField.name,
        tableName: null,
        columnName: null,
      }

    // List
    } else if (isListType(fieldType) && this.currentTable) {
      let ofType = fieldType.ofType
      ofType = isNonNullType(ofType) ? ofType.ofType : ofType
      if (isObjectType(ofType)) {
        // Foreign Type
        const onSameType = this.currentType === ofType.name
        const foreignType = this.typeMap[ofType.name]
        if (!foreignType) {
          console.warn(`Foreign type ${ofType.name} not found on field ${this.currentType}.${field.name}.`)
          return null
        }
        if (!isObjectType(foreignType)) {
          console.warn(`Foreign type ${ofType.name} is not Object type on field ${this.currentType}.${field.name}.`)
          return null
        }

        // Foreign Field
        const foreignKey = onSameType ? field.name : annotations.manyToMany || this.currentTable.name.toLowerCase()
        const foreignField = foreignType.getFields()[foreignKey]
        if (!foreignField) { return null }
        // @db.foreign
        const foreignAnnotations: any = parseAnnotations('db', foreignField.description || null)
        const foreignAnnotation = foreignAnnotations.foreign
        if (foreignAnnotation && foreignAnnotation !== field.name) { return null }
        // Type
        const foreignFieldType = isNonNullType(foreignField.type) ? foreignField.type.ofType : foreignField.type
        if (!isListType(foreignFieldType)) { return null }

        // Create join table for many-to-many
        const defaultName = this.getName([
          `${this.currentType}_${field.name}`,
          `${foreignType.name}_${foreignField.name}`,
        ].sort().join('_join_'))
        const tableName: string = annotations.table || defaultName
        let joinTable = this.database.tableMap.get(tableName) || null
        if (!joinTable) {
          joinTable = {
            name: tableName,
            comment: escapeComment(annotations.tableComment) || `[Auto] Join table between ${this.currentType}.${field.name} and ${foreignType.name}.${foreignField.name}`,
            annotations: {},
            columns: [],
            columnMap: new Map(),
            indexes: [],
            primaries: [],
            uniques: [],
          }
          this.tableQueue.push(joinTable)
          this.database.tableMap.set(tableName, joinTable)
        }
        let descriptors = []
        if (onSameType) {
          const key = annotations.manyToMany || 'id'
          const foreignField = foreignType.getFields()[key]
          if (!foreignField) {
            console.warn(`Foreign field ${key} on type ${ofType.name} not found on field ${this.currentType}.${field.name}.`)
            return null
          }
          const descriptor = this.getFieldDescriptor(foreignField, ofType)
          if (!descriptor) { return null }
          descriptors = [
            descriptor,
            {
              ...descriptor,
            },
          ]
        } else {
          const descriptor = this.getFieldDescriptor(foreignField, ofType)
          if (!descriptor) { return null }
          descriptors = [descriptor]
        }
        for (const descriptor of descriptors) {
          if (joinTable.columnMap.get(descriptor.name)) {
            descriptor.name += '_other'
          }
          joinTable.columns.push(descriptor)
          joinTable.columnMap.set(descriptor.name, descriptor)
        }
        // Index
        joinTable.indexes.push({
          columns: descriptors.map((d) => d.name),
          name: `${joinTable.name}_${descriptors.map((d) => d.name).join('_')}_index`.toLowerCase().substr(0, 63),
          type: null,
        })
        return null
      } else if (this.mapListToJson) {
        type = 'json'
        args = []
      } else {
        console.warn(`Unsupported Scalar/Enum list on field ${this.currentType}.${field.name}. Use @db.type: "json"`)
        return null
      }
    // Unsupported
    } else {
      console.warn(`Field ${this.currentType}.${field.name} of type ${fieldType ? fieldType.toString() : '*unknown*'} not supported. Consider specifying column type with:
      """
      @db.type: "text"
      """
      as the field comment.`)
      return null
    }

    // Index
    for (const type of INDEX_TYPES) {
      const annotation = annotations[type.annotation]
      if (this.currentTable && (annotation ||
        (type.default && isScalarType(fieldType) && type.default(field.name, fieldType.name) && annotation !== false))
      ) {
        let indexName: string | null = null
        let indexType: string | null = null
        if (typeof annotation === 'string') {
          indexName = annotation
        } else if (type.hasType && typeof annotation === 'object') {
          indexName = annotation.name
          indexType = annotation.type
        }
        // @ts-ignore
        const list: any[] = this.currentTable[type.list]
        let index = indexName ? list.find((i) => i.name === indexName) : null
        if (!index) {
          index = type.hasType ? {
            name: indexName,
            type: indexType,
            columns: [],
          } : {
            name: indexName,
            columns: [],
          }
          if (type.max && list.length === type.max) {
            list.splice(0, 1)
          }
          list.push(index)
        }
        index.columns.push(columnName)
        if (!index.name) {
          index.name = type.defaultName(this.currentTable.name, columnName).toLowerCase().substr(0, 63)
        }
      }
    }

    return {
      name: columnName,
      comment: escapeComment(stripAnnotations(field.description || null)),
      annotations,
      type,
      args: args || [],
      nullable: !notNull,
      foreign,
      defaultValue: annotations.default || null,
    }
  }

  /**
   * Put the correct values for `foreign.tableName` and `foreign.columnName` in the columns.
   */
  private fillForeignKeys () {
    for (const table of this.database.tables) {
      for (const column of table.columns) {
        if (column.foreign) {
          const foreignTable = this.database.tableMap.get(column.foreign.type || '')
          if (!foreignTable) {
            console.warn(`Foreign key ${table.name}.${column.name}: Table not found for type ${column.foreign.type}.`)
            continue
          }
          const foreignColumn = foreignTable.columnMap.get(column.foreign.field || '')
          if (!foreignColumn) {
            console.warn(`Foreign key ${table.name}.${column.name}: Column not found for field ${column.foreign.field} in table ${foreignTable.name}.`)
            continue
          }
          column.foreign.tableName = foreignTable.name
          column.foreign.columnName = foreignColumn.name
        }
      }
    }
  }
}
