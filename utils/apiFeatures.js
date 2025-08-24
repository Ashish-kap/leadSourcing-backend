class APIFeatures {
  constructor(getAll, queryString) {
    this.getAll = getAll;

    this.queryString = queryString;
  }

  filter() {
    const queryObj = { ...this.queryString };
    const excludedFields = ["page", "sort", "limit", "fields"];
    excludedFields.forEach((el) => delete queryObj[el]);
    //    console.log(req.query,queryObj);

    // 2) ADVANCE FILTERING

    let queryStr = JSON.stringify(queryObj);
    queryStr = queryStr.replace(/\b(gte|gt|lte|lt)\b/g, (match) => `$${match}`);
    // console.log(JSON.parse(queryStr))
    this.getAll.find(JSON.parse(queryStr));
    // let getAll = Tour.find(JSON.parse(queryStr));
    // console.log(req.query.sort)
    return this;
  }

  sorting() {
    if (this.queryString.sort) {
      const sortBy = this.queryString.sort.split(",").join(" ");
      this.getAll = this.getAll.sort(sortBy);
    } else {
      this.getAll = this.getAll.sort("-createdAt");
    }
    return this;
  }

  fields() {
    if (this.queryString.fields) {
      const getfields = this.queryString.fields.split(",").join("");
      this.getAll = this.getAll.select(getfields);
    } else {
      this.getAll = this.getAll.select("-__v");
    }
    return this;
  }
  paginations() {
    const page = this.queryString.page * 1 || 1;
    const limit = this.queryString.limit * 1 || 10;
    var skip = (page - 1) * limit;
    this.getAll = this.getAll.skip(skip).limit(limit);
    // if(this.queryString.page){
    //     const numOfTours =  Tour.countDocuments();
    //     if(skip > numOfTours) throw new Error('this page doesnt exist')
    // }
    return this;
  }
}
export default APIFeatures;
