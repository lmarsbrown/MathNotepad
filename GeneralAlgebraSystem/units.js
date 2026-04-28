/**
 * A geometric basis vector in 3D space (x, y, or z).
 * GeoVecs are anti-commutative: xy = -yx, and a vector squares to zero: xx = 0.
 */
class GeoVec extends AlgebraicObject{
    static subtypes = 3;

    /**
     * @param {'x'|'y'|'z'} vec - Which basis direction this vector represents
     */
    constructor(vec){
        super();

        //Computing subtype offsets here in the class rather than manually defining them in the registry is fine as a general approach
        //It is expected that classes with subtypes may have a large number of subtypes that follow a deterministic order.
        //For example, many vectors of different length should all ahve different ids, and manually defining the id would be unnecesary
        let idTable = {x:0,y:1,z:2};
        let idOffset = idTable[vec];
        this.label = "geo_"+vec;
        if(idOffset === undefined){
            console.error("Attempted to create a geovec of unknown type");
            debugger;
        }
        this.id += idOffset;

        this.vecName = vec;
    }

    /**
     * Applies geometric algebra product rules for two GeoVecs.
     * Same vectors square to zero (e.g. x*x = 0); different vectors anti-commute (e.g. x*y = -y*x).
     * Non-GeoVec units are simply reordered according to canonical id ordering.
     * @param {AlgebraicObject} other - The unit being multiplied with this one (the lower-id operand)
     * @param {boolean} orderFlipped - Whether other originally appeared before this in the term
     * @returns {AlgebraicObject[]|null} Replacement units, or null if no interaction applies
     */
    combineWith(other,orderFlipped){
        if(other instanceof GeoVec){
            if(other.id == this.id){
                //Returning [] effectively removes this and other from the term. This is different from returning null which will leave them in place without commuting.
                //This follows intuitively from the fact that any array returned from this function will be spliced into the term in place of the two units being combined. If no units should be added, then we return an empty array.
                //This is the same as returning [new Scalar(1)], because multiplying by 1 is the same as not multiplying by anything.
                return [];
            }
            else if(orderFlipped){
                return [new ScalarExpression(-1),other,this]
            }
        }

        if(orderFlipped){
            return [other,this];
        }
        return null;
    }

    /**
     * Returns a new GeoVec with the same direction as this one.
     * @returns {GeoVec}
     */
    clone(){
        return new GeoVec(this.vecName);
    }

}

/**
 * The imaginary unit i, where i*i = -1.
 */
class Imaginary extends AlgebraicObject{
    constructor(){
        super();
        this.label = "imaginary";
    }

    /**
     * Applies the rule i*i = -1. If the other unit is also Imaginary, returns a ScalarExpression(-1);
     * otherwise defers to canonical id ordering.
     * @param {AlgebraicObject} other - The unit being multiplied with this one (the lower-id operand)
     * @param {boolean} orderFlipped - Whether other originally appeared before this in the term
     * @returns {AlgebraicObject[]|null} Replacement units, or null if no interaction applies
     */
    combineWith(other,orderFlipped){
        if(other.id == this.id){
            return [new ScalarExpression(-1)];
        }

        if(orderFlipped){
            return [other,this];
        }
        return null;
    }

    /**
     * Returns a new Imaginary unit.
     * @returns {Imaginary}
     */
    clone(){
        return new Imaginary();
    }
}

//This is a list of all unit types by priority. 
//The purpose of the priority system is allow you to only declare how units interact in one direction
//Interactions will always be called from the unit with a higher id which allows more complicated units to have more control over their own behaviour


let _unitPriority = [
    ScalarExpression,
    GeoVec,
    Imaginary
];

{
    let _currentId = 0;
    for(let i = 0; i < _unitPriority.length; i++){
        let subtypes = _unitPriority[i].subtypes;

        idRegistry[_unitPriority[i].name] = _currentId;
        if(subtypes != undefined){
            _currentId += subtypes;
        }
        else{
            _currentId++;
        }
    }

}
