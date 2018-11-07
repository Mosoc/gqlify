import {
  ValueNode,
  Kind,
  TypeNode,
  NamedTypeNode,
  FieldDefinitionNode,
  DocumentNode,
  TypeDefinitionNode,
  DirectiveNode,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLID,
} from 'graphql';
import {
  IntValue,
  FloatValue,
  StringValue,
  BooleanValue,
  EnumValue,
  NullValue,
  ListValue,
  ObjectValue
} from './inputValue';
import {
  ScalarField,
  CustomScalarField,
  EnumField,
  ObjectField,
} from './field';
import {
  Model,
  ScalarField as DataScalarField,
  CustomScalarField as DataCustomScalarField,
  EnumField as DataEnumField,
  ObjectField as DataObjectField,
  RelationField as DataRelationField,
} from '../dataModel';
import { InputValue } from './inputValue/interface';
import { reduce, last, forEach } from 'lodash';
import { SdlField, SdlFieldType } from './field/interface';
import SdlObjectType from './namedType/objectType';
import { SdlDirective } from './interface';
import { DataModelType } from '../dataModel/type';
import { SdlNamedType } from './namedType/interface';
import SdlEnumType from './namedType/enumType';
import { API_DIRECTIVE_RELATION_TO_FIELD, API_DIRECTIVE } from './constants';
// tslint:disable-next-line:no-var-requires
const { isSpecifiedScalarType } = require('graphql/type/scalars');

export const parseDirectiveInput = (node: ValueNode): InputValue => {
  switch (node.kind) {
    case Kind.INT:
      return new IntValue({value: parseInt(node.value, 10)});

    case Kind.FLOAT:
      return new FloatValue({value: parseFloat(node.value)});

    case Kind.STRING:
      return new StringValue({value: node.value});

    case Kind.BOOLEAN:
      return new BooleanValue({value: node.value});

    case Kind.ENUM:
      return new EnumValue({value: node.value});

    case Kind.NULL:
      return new NullValue();

    case Kind.LIST:
      const values = node.values.map(nestedNode => parseDirectiveInput(nestedNode));
      return new ListValue({values});

    case Kind.OBJECT:
      const fields = reduce(node.fields, (result, field) => {
        result[field.name.value] = parseDirectiveInput(field.value);
        return result;
      }, {});
      return new ObjectValue({fields});

    // all the scalars
    default:
      throw new Error(`not supported type in directive parsing: ${node.kind}`);
  }
};

export const parseDirectiveNode = (node: DirectiveNode): SdlDirective => {
  return {
    name: node.name.value,
    args: reduce(node.arguments, (result, argNode) => {
      result[argNode.name.value] = parseDirectiveInput(argNode.value);
      return result;
    }, {}),
  };
};

export const findTypeInDocumentAst = (node: DocumentNode, name: string) => {
  const foundNode = node.definitions.find((defNode: TypeDefinitionNode) => {
    return defNode.name.value === name;
  });
  return foundNode ? foundNode.kind : null;
};

export const parseWrappedType = (node: TypeNode, typeWrapped: string[] = []) => {
  if (node.kind === Kind.NON_NULL_TYPE) {
    return parseWrappedType(node.type, typeWrapped.concat(Kind.NON_NULL_TYPE));
  }

  if (node.kind === Kind.LIST_TYPE) {
    return parseWrappedType(node.type, typeWrapped.concat(Kind.LIST_TYPE));
  }

  return {type: node.name.value, wrapped: typeWrapped};
};

export const createSdlField = (
  documentNode: DocumentNode,
  node: FieldDefinitionNode,
  getSdlNamedType: (name: string) => SdlNamedType,
  ): SdlField => {
  const namedType = node.type as NamedTypeNode;
  const {type, wrapped} = parseWrappedType(namedType);
  // not dealing with nested list for now
  const nonNull = wrapped[0] === Kind.NON_NULL_TYPE;
  const list = (wrapped[0] === Kind.LIST_TYPE || wrapped[1] === Kind.LIST_TYPE);
  const itemNonNull = (list && last(wrapped) === Kind.NON_NULL_TYPE);
  const fieldConfigs = {typename: type, nonNull, list, itemNonNull};

  if (isSpecifiedScalarType(namedType)) {
    return new ScalarField(fieldConfigs);
  }

  // find its type
  const nodeType = findTypeInDocumentAst(documentNode, type);
  if (!nodeType) {
    throw new Error(`type of "${type}" not found in document`);
  }

  switch (nodeType) {
    case Kind.SCALAR_TYPE_DEFINITION:
      return new CustomScalarField(fieldConfigs);

    case Kind.ENUM_TYPE_DEFINITION:
      const enumField = new EnumField(fieldConfigs);
      enumField.setEnumType(
        () => getSdlNamedType(field.getTypeName()) as SdlEnumType,
      );
      return enumField;

    case Kind.OBJECT_TYPE_DEFINITION:
      const field = new ObjectField(fieldConfigs);
      field.setObjectType(
        () => getSdlNamedType(field.getTypeName()) as SdlObjectType,
      );
      return field;
  }
};

export const parseDataModelScalarType = (field: SdlField): DataModelType => {
  switch (field.getTypeName()) {
    case GraphQLString.name:
      return DataModelType.STRING;

    case GraphQLInt.name:
      return DataModelType.INT;

    case GraphQLFloat.name:
      return DataModelType.FLOAT;

    case GraphQLBoolean.name:
      return DataModelType.BOOLEAN;

    case GraphQLID.name:
      return DataModelType.ID;

    default:
      throw new Error(`cant parse dataModel type for field type: ${field.getTypeName()}`);
  }
};

export const createDataFieldFromSdlField = (
  name: string,
  field: SdlField,
  isApiObjectType: (sdlObjectType: SdlObjectType) => boolean,
  getModel: (name: string) => Model,
  ) => {
  switch (field.getFieldType()) {
    case SdlFieldType.SCALAR:
      const type = parseDataModelScalarType(field);
      return new DataScalarField({
        name,
        type,
      });

    case SdlFieldType.CUSTOM_SCALAR:
      return new DataCustomScalarField({
        name,
        typename: field.getTypeName(),
      });

    case SdlFieldType.ENUM:
      return new DataEnumField({
        name,
        enumName: field.getTypeName(),
        values: (field as EnumField).getEnumType().getValues(),
      });

    case SdlFieldType.OBJECT:
      const objectField = field as ObjectField;
      if (isApiObjectType(objectField.getObjectType())) {
        return new DataRelationField({
          name,
          relationTo: () => getModel(objectField.getTypeName()),
        });
      } else {
        const fields = objectField.getObjectType().getFields();
        return new DataObjectField({
          name,
          typename: objectField.getTypeName(),
          fields: Object.keys(fields).map(key => {
            const nestedField = fields[key];
            return createDataFieldFromSdlField(key, nestedField, isApiObjectType, getModel);
          }),
        });
      }
  }
};

export const createDataModelFromSdlObjectType = (
  sdlObjectType: SdlObjectType,
  isApiObjectType: (sdlObjectType: SdlObjectType) => boolean,
  getModel: (name: string) => Model,
  ): Model => {
  const model = new Model({
    name: sdlObjectType.getName(),
  });

  // append fields
  forEach(sdlObjectType.getFields(), (sdlField, key) => {
    model.appendField(
      createDataFieldFromSdlField(key, sdlField, isApiObjectType, getModel),
    );
  });
  return model;
};